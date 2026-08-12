import path from 'node:path';
import { performance } from 'node:perf_hooks'; // ★ 시간 측정용 - 나중에 이 줄만 삭제하면 됨
import { Jimp } from 'jimp';
import { ensureCv } from './cvReady.js';
import { detectDocument } from './scanner.js';
import { warpDocument } from './warping.js';

type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

/**
 * Jimp로 디코딩한 이미지(RGBA 픽셀 버퍼)를 OpenCV의 cv.Mat(CV_8UC4)으로 변환합니다.
 */
function jimpToMat(cv: any, image: JimpImage): any {
    const mat = new cv.Mat(image.bitmap.height, image.bitmap.width, cv.CV_8UC4);
    mat.data.set(image.bitmap.data);
    return mat;
}

/**
 * cv.Mat(CV_8UC4)을 파일로 저장 가능한 Jimp 이미지로 변환합니다.
 */
function matToJimp(mat: any) {
    // mat.delete() 이후에도 사용할 수 있도록 픽셀 데이터를 복사해 둔다.
    const data = Buffer.from(mat.data);
    return Jimp.fromBitmap({ data, width: mat.cols, height: mat.rows });
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
    const image = await Jimp.read(inputPath);

    const srcMat = jimpToMat(cv, image);
    let contour: any = null;
    let warped: any = null;

    try {
        // ↓↓↓ 시간 측정용 - 나중에 이 블록만 삭제하면 됨 ↓↓↓
        const processStart = performance.now();
        // ↑↑↑ 시간 측정용 ↑↑↑

        contour = await detectDocument(srcMat);
        if (!contour) {
            throw new Error('문서(사각형) 영역을 찾지 못했습니다. 배경과 문서 대비가 뚜렷한 사진으로 다시 시도해 보세요.');
        }

        warped = await warpDocument(srcMat, contour);
        if (!warped) {
            throw new Error('원근 변환에 실패했습니다.');
        }

        // ↓↓↓ 시간 측정용 - 나중에 이 줄만 삭제하면 됨 ↓↓↓
        const computeMs = performance.now() - processStart;
        // ↑↑↑ 시간 측정용 ↑↑↑

        const { dir, name, ext } = path.parse(inputPath);
        const outputPath = path.join(dir, `${name}_warp${ext}`);

        const outImage = matToJimp(warped);
        await outImage.write(outputPath as `${string}.${string}`);

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
