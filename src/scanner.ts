import cv from '@techstark/opencv-js';
import { ensureCv } from './cvReady.js';

// 윤곽선 검출용 축소 기준 크기. Canny/findContours 비용은 픽셀 수에 비례하므로
// 검출 단계에서만 이 크기로 축소해 연산량을 줄이고, 찾은 좌표는 원본 스케일로 되돌린다.
// (2000 미만으로 더 줄이면 이 프로젝트 샘플 사진 기준으로 배경의 작은 사각형을
//  문서로 오검출하는 경우가 있어 2000을 하한으로 둔다.)
const DETECT_MAX_DIM = 2000;

/**
 * 이미지에서 종이나 화면(가장 큰 사각형)의 4개 모서리 좌표를 찾습니다.
 * @param srcMat 원본 이미지 객체 (cv.Mat)
 * @returns 4개의 꼭짓점 좌표를 담은 cv.Mat (찾지 못하면 null)
 */
export async function detectDocument(srcMat: cv.Mat): Promise<cv.Mat | null> {
    // OpenCV.js WASM 런타임이 준비된 이후에만 cv.* API를 사용할 수 있다.
    const cv = await ensureCv();

    // 긴 변이 DETECT_MAX_DIM을 넘으면 그 비율만큼 축소 (이미 작으면 축소하지 않음)
    const scale = Math.min(1, DETECT_MAX_DIM / Math.max(srcMat.cols, srcMat.rows));

    // 사용할 메모리 사전 할당
    const gray = new cv.Mat();
    const resized = scale < 1 ? new cv.Mat() : null;
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    let documentContour: cv.Mat | null = null;
    let maxArea = 0;

    try {
        // 1. 흑백 변환
        cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY, 0);

        // 1-1. 검출용 축소 (있는 경우)
        let detectSrc = gray;
        if (resized) {
            const dsize = new cv.Size(Math.round(srcMat.cols * scale), Math.round(srcMat.rows * scale));
            cv.resize(gray, resized, dsize, 0, 0, cv.INTER_AREA);
            detectSrc = resized;
        }

        // 2. 가우시안 블러 (5x5 커널 사용, 노이즈 제거)
        const ksize = new cv.Size(5, 5);
        cv.GaussianBlur(detectSrc, blurred, ksize, 0, 0, cv.BORDER_DEFAULT);

        // 3. 캐니 엣지 검출 (윤곽선 뚜렷하게)
        cv.Canny(blurred, edges, 75, 200);

        // 4. 윤곽선 찾기
        cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

        // 5. 가장 큰 4각형 윤곽선 찾기
        // 면적 기준(1000)은 축소된 좌표계 기준이므로 scale^2만큼 같이 줄여 원본 기준과 동등하게 맞춘다.
        const minArea = 1000 * scale * scale;
        for (let i = 0; i < contours.size(); ++i) {
            const contour = contours.get(i);
            const area = cv.contourArea(contour);

            if (area > minArea) {
                // 윤곽선의 둘레 길이 계산
                const perimeter = cv.arcLength(contour, true);
                const approx = new cv.Mat();

                // 다각형으로 근사화 (둘레의 2% 오차 허용)
                cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

                // 꼭짓점이 4개이고, 지금까지 찾은 면적보다 큰 경우
                if (approx.rows === 4 && area > maxArea) {
                    // 이전 데이터가 있으면 메모리 해제
                    if (documentContour) documentContour.delete();

                    documentContour = approx.clone(); // 복사해서 저장
                    maxArea = area;
                }
                approx.delete();
            }
            contour.delete();
        }

        // 축소된 좌표계에서 찾았다면 원본 좌표계로 되돌린다.
        if (documentContour && scale < 1) {
            const data = documentContour.data32S;
            for (let i = 0; i < data.length; i++) {
                data[i] = Math.round(data[i] / scale);
            }
        }

        return documentContour;

    } catch (error) {
        console.error('검출 중 오류 발생:', error);
        return null;
    } finally {
        // [중요] C++ WebAssembly 기반이므로 사용이 끝난 메모리는 직접 해제해야 함
        gray.delete();
        resized?.delete();
        blurred.delete();
        edges.delete();
        contours.delete();
        hierarchy.delete();
    }
}