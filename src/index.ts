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

async function main(): Promise<void> {
    const inputPath = process.argv[2] ?? 'input.jpg';
    const outputPath = process.argv[3] ?? 'output.jpg';

    console.log('OpenCV.js 로딩 중...');
    const cv = await ensureCv();
    console.log('OpenCV.js 준비 완료');

    console.log(`이미지 로드: ${inputPath}`);
    let image: JimpImage;
    try {
        image = await Jimp.read(inputPath);
    } catch (error) {
        console.error(`이미지를 불러올 수 없습니다: ${inputPath}`);
        console.error(error);
        process.exitCode = 1;
        return;
    }

    const srcMat = jimpToMat(cv, image);
    let contour: any = null;
    let warped: any = null;

    try {
        contour = await detectDocument(srcMat);

        if (!contour) {
            console.error('문서(사각형) 영역을 찾지 못했습니다. 배경과 문서 대비가 뚜렷한 사진으로 다시 시도해 보세요.');
            process.exitCode = 1;
            return;
        }

        warped = await warpDocument(srcMat, contour);

        if (!warped) {
            console.error('원근 변환에 실패했습니다.');
            process.exitCode = 1;
            return;
        }

        const outImage = matToJimp(warped);
        await outImage.write(outputPath as `${string}.${string}`);
        console.log(`완료: ${outputPath} (${warped.cols}x${warped.rows})`);

    } finally {
        srcMat.delete();
        contour?.delete();
        warped?.delete();
    }
}

main().catch((error) => {
    console.error('예상치 못한 오류 발생:', error);
    process.exitCode = 1;
});
