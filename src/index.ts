import path from 'node:path';
import sharp from 'sharp';
import { ensureCv } from './cvReady.js';
import { deskewImage } from './deskew.js';

/**
 * warpImage()의 반환 타입.
 * - success: 회전 보정이 적용됐으면 true. 기울기가 미미해 불필요했거나 실패했으면 false.
 * - method: 실제로 적용된 보정 방식.
 *   - 'deskew': 텍스트 줄 방향 기준 회전(스큐)만 보정함. 캔버스를 확장해서 회전하므로
 *     원본 내용을 잘라내지 않는다.
 *   - 'original': 보정이 적용되지 않아 원본 그대로 반환함.
 * - image: 결과 이미지를 JPEG로 인코딩한 base64 data URL (예: "data:image/jpeg;base64,...").
 */
export interface WarpResult {
    success: boolean;
    method: 'deskew' | 'original';
    image: string;
}

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
 * cv.Mat(CV_8UC4, RGBA)을 JPEG로 인코딩해 base64 data URL 문자열로 변환합니다.
 */
async function matToBase64(mat: any): Promise<string> {
    // mat.delete() 이후에도 사용할 수 있도록 픽셀 데이터를 복사해 둔다.
    const data = Buffer.from(mat.data);
    const jpegBuffer = await sharp(data, { raw: { width: mat.cols, height: mat.rows, channels: 4 } })
        .jpeg()
        .toBuffer();
    return `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
}

/**
 * 입력 이미지 경로 하나만 받아 텍스트 줄 방향 기준 회전 보정(deskew)을 시도해서,
 * 결과 이미지를 base64로 인코딩해 JSON({ success, method, image })으로 반환합니다.
 *
 * 문서 사각형을 찾아 자르는(원근 변환) 방식은 쓰지 않는다 — 전처리 없이 OCR을 돌렸다면
 * 봤을 내용이, 사각형이 잘못 검출돼 크롭되면서 아예 사라져버리는 위험이 있기 때문이다.
 * 회전 보정은 캔버스를 확장해서 적용하므로 원본 내용을 절대 잘라내지 않는다 — 최악의
 * 경우에도 "보정이 안 됨"이지 "내용이 사라짐"은 아니다.
 *
 * @param inputPath 입력 이미지 경로
 * @returns { success, method, image } — image는 "data:image/jpeg;base64,..." 형식의 문자열
 */
export async function warpImage(inputPath: string): Promise<WarpResult> {
    const cv = await ensureCv();
    const srcMat = await fileToMat(cv, inputPath);
    let corrected: any = null; // deskew 결과 mat. null이면 원본을 그대로 쓴다.
    let method: WarpResult['method'] = 'original';
    // 실패 이유. method가 'original'일 때만 JSON 로그에 쓰인다.
    let failReason: string | null = null;

    try {
        // ↓↓↓ 시간 측정용 - 나중에 이 블록만 삭제하면 됨 ↓↓↓
        const processStart = performance.now();
        // ↑↑↑ 시간 측정용 ↑↑↑

        const deskewResult = await deskewImage(srcMat);
        if (deskewResult.applied) {
            corrected = deskewResult.mat;
            method = 'deskew';
        } else {
            deskewResult.mat.delete();
            failReason = deskewResult.reason ?? '회전 보정이 적용되지 않았습니다.';
        }

        // ↓↓↓ 시간 측정용 - 나중에 이 줄만 삭제하면 됨 ↓↓↓
        const computeMs = performance.now() - processStart;
        // ↑↑↑ 시간 측정용 ↑↑↑

        const success = method !== 'original';
        const image = await matToBase64(corrected ?? srcMat);

        // 아무 보정도 적용하지 못한 경우에만(진짜 실패) JSON 로그를 남긴다.
        // base64 이미지 대신 inputPath를 남긴다 — base64는 실패 하나당 수백 KB라 로그가 금방
        // 읽기 힘들어지고, 어차피 호출부가 넘긴 파일 경로로 원본 이미지를 직접 열어볼 수 있다.
        if (method === 'original') {
            console.error(JSON.stringify({ success: false, reason: failReason, inputPath }));
        }

        // ↓↓↓ 시간 측정용 - 나중에 이 블록만 삭제하면 됨 ↓↓↓
        const totalMs = performance.now() - processStart;
        console.log(`순수 연산 시간 (회전 보정): ${computeMs.toFixed(1)}ms`);
        console.log(`처리 시간 (연산 + base64 인코딩, 입력 로드 제외): ${totalMs.toFixed(1)}ms`);
        // ↑↑↑ 시간 측정용 ↑↑↑

        return { success, method, image };
    } finally {
        srcMat.delete();
        corrected?.delete();
    }
}

// 단독 실행 시(CLI)에만 동작: `tsx src/index.ts <입력 이미지 경로>`
// warpImage()는 base64 JSON을 반환하므로, CLI에서는 결과를 눈으로 확인할 수 있도록
// base64를 디코딩해 "원본이름_warp.확장자" 파일로 저장한다.
if (require.main === module) {
    const inputPath = process.argv[2] ?? 'input.jpg';

    warpImage(inputPath)
        .then(async ({ success, method, image }) => {
            const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
            const { dir, name, ext } = path.parse(inputPath);
            const outputPath = path.join(dir, `${name}_warp${ext}`);
            await sharp(Buffer.from(base64Data, 'base64')).toFile(outputPath);
            console.log(`완료 (success=${success}, method=${method}): ${outputPath}`);
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}
