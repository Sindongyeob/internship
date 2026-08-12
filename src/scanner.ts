import cv from '@techstark/opencv-js';
import { ensureCv } from './cvReady.js';

/**
 * 이미지에서 종이나 화면(가장 큰 사각형)의 4개 모서리 좌표를 찾습니다.
 * @param srcMat 원본 이미지 객체 (cv.Mat)
 * @returns 4개의 꼭짓점 좌표를 담은 cv.Mat (찾지 못하면 null)
 */
export async function detectDocument(srcMat: cv.Mat): Promise<cv.Mat | null> {
    // OpenCV.js WASM 런타임이 준비된 이후에만 cv.* API를 사용할 수 있다.
    const cv = await ensureCv();

    // 사용할 메모리 사전 할당
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    let documentContour: cv.Mat | null = null;
    let maxArea = 0;

    try {
        // 1. 흑백 변환
        cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY, 0);

        // 2. 가우시안 블러 (5x5 커널 사용, 노이즈 제거)
        const ksize = new cv.Size(5, 5);
        cv.GaussianBlur(gray, blurred, ksize, 0, 0, cv.BORDER_DEFAULT);

        // 3. 캐니 엣지 검출 (윤곽선 뚜렷하게)
        cv.Canny(blurred, edges, 75, 200);

        // 4. 윤곽선 찾기
        cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

        // 5. 가장 큰 4각형 윤곽선 찾기
        for (let i = 0; i < contours.size(); ++i) {
            const contour = contours.get(i);
            const area = cv.contourArea(contour);

            // 노이즈 방지를 위해 일정 면적 이상만 검사 (예: 1000 픽셀 이상)
            if (area > 1000) {
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

        return documentContour;

    } catch (error) {
        console.error('검출 중 오류 발생:', error);
        return null;
    } finally {
        // [중요] C++ WebAssembly 기반이므로 사용이 끝난 메모리는 직접 해제해야 함
        gray.delete();
        blurred.delete();
        edges.delete();
        contours.delete();
        hierarchy.delete();
    }
}