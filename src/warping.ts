import cv from '@techstark/opencv-js';
import { ensureCv } from './cvReady.js';

/** 2차원 좌표를 나타내는 간단한 좌표 타입 */
interface Point {
    x: number;
    y: number;
}

/**
 * 두 점 사이의 유클리드 거리를 계산합니다.
 */
function distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * scanner.ts의 detectDocument가 반환한 윤곽선(cv.Mat, 4x1 2채널)에서
 * 좌표 4개를 일반 JS 배열로 추출합니다.
 */
function extractPoints(contour: cv.Mat): Point[] {
    const data = contour.data32S; // [x0, y0, x1, y1, x2, y2, x3, y3]
    const points: Point[] = [];
    for (let i = 0; i < 4; i++) {
        points.push({ x: data[i * 2], y: data[i * 2 + 1] });
    }
    return points;
}

/**
 * 순서가 뒤섞인 4개의 꼭짓점을 [좌상단, 우상단, 우하단, 좌하단] 순서로 정렬합니다.
 * - 좌표 합(x+y)이 가장 작은 점 = 좌상단, 가장 큰 점 = 우하단
 * - 좌표 차(x-y)가 가장 작은 점 = 좌하단, 가장 큰 점 = 우상단
 */
function orderPoints(points: Point[]): [Point, Point, Point, Point] {
    const sums = points.map((p) => p.x + p.y);
    const diffs = points.map((p) => p.x - p.y);

    const topLeft = points[sums.indexOf(Math.min(...sums))];
    const bottomRight = points[sums.indexOf(Math.max(...sums))];
    const topRight = points[diffs.indexOf(Math.max(...diffs))];
    const bottomLeft = points[diffs.indexOf(Math.min(...diffs))];

    return [topLeft, topRight, bottomRight, bottomLeft];
}

/**
 * 검출된 문서 윤곽선을 기준으로 원근 변환(Perspective Transform)을 적용하여
 * 기울어진 문서를 반듯한 직사각형 이미지로 펴줍니다.
 *
 * @param srcMat 원본 이미지 (cv.Mat)
 * @param contour scanner.ts의 detectDocument가 반환한 4개 꼭짓점 윤곽선 (cv.Mat)
 * @returns 반듯하게 펴진 문서 이미지 (cv.Mat). 실패 시 srcMat의 복사본(원본 이미지)
 */
export async function warpDocument(srcMat: cv.Mat, contour: cv.Mat): Promise<cv.Mat> {
    if (contour.rows !== 4) {
        console.error('윤곽선의 꼭짓점 개수가 4개가 아닙니다. 원본 이미지를 그대로 반환합니다.');
        return srcMat.clone();
    }

    // OpenCV.js WASM 런타임이 준비된 이후에만 cv.* API를 사용할 수 있다.
    const cv = await ensureCv();

    let srcTri: cv.Mat | null = null;
    let dstTri: cv.Mat | null = null;
    let transformMatrix: cv.Mat | null = null;
    const dst = new cv.Mat();

    try {
        const [topLeft, topRight, bottomRight, bottomLeft] = orderPoints(extractPoints(contour));

        // 변환 후 이미지의 가로/세로 길이 계산 (위/아래, 좌/우 중 더 긴 변을 기준으로 삼음)
        const widthTop = distance(topLeft, topRight);
        const widthBottom = distance(bottomLeft, bottomRight);
        const maxWidth = Math.max(Math.round(widthTop), Math.round(widthBottom));

        const heightLeft = distance(topLeft, bottomLeft);
        const heightRight = distance(topRight, bottomRight);
        const maxHeight = Math.max(Math.round(heightLeft), Math.round(heightRight));

        if (maxWidth <= 0 || maxHeight <= 0) {
            console.error('계산된 결과물 크기가 유효하지 않습니다. 원본 이미지를 그대로 반환합니다.');
            dst.delete();
            return srcMat.clone();
        }

        // 원본 이미지에서의 4개 꼭짓점 (변환 전)
        srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            topLeft.x, topLeft.y,
            topRight.x, topRight.y,
            bottomRight.x, bottomRight.y,
            bottomLeft.x, bottomLeft.y,
        ]);

        // 결과 이미지에서의 4개 꼭짓점 (변환 후, 반듯한 직사각형)
        dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            0, 0,
            maxWidth - 1, 0,
            maxWidth - 1, maxHeight - 1,
            0, maxHeight - 1,
        ]);

        // 원근 변환 행렬 계산 및 적용
        transformMatrix = cv.getPerspectiveTransform(srcTri, dstTri);
        const dsize = new cv.Size(maxWidth, maxHeight);
        cv.warpPerspective(
            srcMat,
            dst,
            transformMatrix,
            dsize,
            cv.INTER_LINEAR,
            cv.BORDER_CONSTANT,
            new cv.Scalar()
        );

        return dst;

    } catch (error) {
        console.error('원근 변환 중 오류 발생:', error, '원본 이미지를 그대로 반환합니다.');
        dst.delete();
        return srcMat.clone();
    } finally {
        srcTri?.delete();
        dstTri?.delete();
        transformMatrix?.delete();
    }
}
