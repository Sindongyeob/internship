import path from 'node:path';
import sharp from 'sharp';
import { ensureCv } from './cvReady.js';
import { detectDocument } from './scanner.js';
import { warpDocument } from './warping.js';

/**
 * 이미지 파일을 sharp로 디코딩해 OpenCV의 cv.Mat(CV_8UC4, RGBA)으로 변환합니다.
 */
async function fileToMat(cv: any, inputPath: string): Promise<any> {
    const { data, info } = await sharp(inputPath)
        .rotate()      // EXIF Orientation 태그를 반영해 실제 보이는 방향대로 픽셀을 정렬한다.
        .ensureAlpha() // 원본이 RGB(3채널)여도 RGBA 4채널로 통일해 cv.CV_8UC4와 맞춘다.
        .raw()
        .toBuffer({ resolveWithObject: true });

    const mat = new cv.Mat(info.height, info.width, cv.CV_8UC4);
    mat.data.set(data);
    return mat;
}

/**
 * cv.Mat(CV_8UC4, RGBA)을 sharp로 인코딩해 파일로 저장합니다.
 */
async function matToFile(mat: any, outputPath: string): Promise<void> {
    // mat.delete() 이후에도 사용할 수 있도록 픽셀 데이터를 복사해 둔다.
    const data = Buffer.from(mat.data);
    await sharp(data, { raw: { width: mat.cols, height: mat.rows, channels: 4 } })
        .jpeg()
        .toFile(outputPath);
}

/**
 * 입력 이미지 경로 하나만 받아 문서 검출 + 원근 변환을 수행하고,
 * 같은 폴더에 "원본이름_warp.확장자"로 결과를 저장합니다.
 *
 * @param inputPath 입력 이미지 경로
 * @returns 저장된 결과 이미지의 경로
 */
export async function warpImage(inputPath: string): Promise<string> {
    const cv = await ensureCv();
    const srcMat = await fileToMat(cv, inputPath);
    let contour: any = null;
    let warped: any = null;

    try {
        // ↓↓↓ 시간 측정용 - 나중에 이 블록만 삭제하면 됨 ↓↓↓
        const processStart = performance.now();
        // ↑↑↑ 시간 측정용 ↑↑↑

        contour = await detectDocument(srcMat);
        if (!contour) {
            console.warn('문서(사각형) 영역을 찾지 못했습니다. 원본 이미지를 그대로 반환합니다.');
        } else {
            warped = await warpDocument(srcMat, contour);
            if (!warped) {
                console.warn('원근 변환에 실패했습니다. 원본 이미지를 그대로 반환합니다.');
            }
        }

        // ↓↓↓ 시간 측정용 - 나중에 이 줄만 삭제하면 됨 ↓↓↓
        const computeMs = performance.now() - processStart;
        // ↑↑↑ 시간 측정용 ↑↑↑

        const { dir, name, ext } = path.parse(inputPath);
        const outputPath = path.join(dir, `${name}_warp${ext}`);

        // 엣지 검출/원근 변환이 실패한 경우 원본(srcMat)을 그대로 저장한다.
        await matToFile(warped ?? srcMat, outputPath);

        // ↓↓↓ 시간 측정용 - 나중에 이 블록만 삭제하면 됨 ↓↓↓
        const totalMs = performance.now() - processStart;
        console.log(`순수 연산 시간 (엣지 검출 + 원근 변환): ${computeMs.toFixed(1)}ms`);
        console.log(`처리 시간 (연산 + 출력 저장, 입력 로드 제외): ${totalMs.toFixed(1)}ms`);
        // ↑↑↑ 시간 측정용 ↑↑↑

        return outputPath;
    } finally {
        srcMat.delete();
        contour?.delete();
        warped?.delete();
    }
}

// 단독 실행 시(CLI)에만 동작: `tsx src/index.ts <입력 이미지 경로>`
if (require.main === module) {
    const inputPath = process.argv[2] ?? 'input.jpg';

    warpImage(inputPath)
        .then((outputPath) => {
            console.log(`완료: ${outputPath}`);
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}
