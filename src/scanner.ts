import cv from '@techstark/opencv-js';
import { ensureCv } from './cvReady.js';
import { analyzeImage, PreprocessDecision } from './analyzePreprocess.js';

// 윤곽선 검출용 축소 기준 크기. Canny/findContours 비용은 픽셀 수에 비례하므로
// 검출 단계에서만 이 크기로 축소해 연산량을 줄이고, 찾은 좌표는 원본 스케일로 되돌린다.
// (2000 미만으로 더 줄이면 이 프로젝트 샘플 사진 기준으로 배경의 작은 사각형을
//  문서로 오검출하는 경우가 있어 2000을 하한으로 둔다.)
const CLOSE_KERNEL = 5;
const DETECT_MAX_DIM = 2000;

// 검출된 4각형이 전체 이미지 면적에서 차지해야 하는 최소 비율.
// 목표 문서(종이/화면)의 테두리 일부가 사진 프레임 밖으로 잘려 나가면, 실제로는
// 문서 안의 작은 표/칸 하나가 "우연히 프레임 안에서 닫힌 가장 큰 4각형"이 되어
// 오검출되는 경우가 있다. 이런 경우를 걸러내기 위한 하한선.
const MIN_AREA_RATIO = 0.05;

const MEDIAN_BLUR = 5;
interface Point {
    x: number;
    y: number;
}
function pickCorners(hull: cv.Mat): Point[] | null {
    const d = hull.data32S; // convexHull(returnPoints=true) → CV_32SC2 → [x0,y0,x1,y1,...]
    if (d.length < 8) return null; // 점이 4개 미만이면 실패

    let tl: Point = { x: d[0], y: d[1] };
    let br: Point = tl;
    let tr: Point = tl;
    let bl: Point = tl;

    for (let i = 0; i < d.length; i += 2) {
        const p: Point = { x: d[i], y: d[i + 1] };
        const sum = p.x + p.y;
        const diff = p.x - p.y;
        if (sum < tl.x + tl.y) tl = p;
        if (sum > br.x + br.y) br = p;
        if (diff > tr.x - tr.y) tr = p;
        if (diff < bl.x - bl.y) bl = p;
    }

    const corners = [tl, tr, br, bl];
    // 4점이 서로 구별되는지(퇴화 아닌지) 확인
    const uniq = new Set(corners.map((p) => `${p.x},${p.y}`));
    if (uniq.size < 4) return null;
    return corners;
}

/** 사각형 4점의 면적 (shoelace). */
function quadArea(c: Point[]): number {
    let a = 0;
    for (let i = 0; i < 4; i++) {
        const p = c[i];
        const q = c[(i + 1) % 4];
        a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
}

/**
 * 이미지에서 종이나 화면(가장 큰 사각형)의 4개 모서리 좌표를 찾습니다.
 * @param srcMat 원본 이미지 객체 (cv.Mat)
 * @returns 4개의 꼭짓점 좌표를 담은 cv.Mat (찾지 못했거나, 전체 이미지 대비 너무 작으면 null)
 */
export async function detectDocument(srcMat: cv.Mat): Promise<cv.Mat | null> {
    // OpenCV.js WASM 런타임이 준비된 이후에만 cv.* API를 사용할 수 있다.
    const cv = await ensureCv();

    // 긴 변이 DETECT_MAX_DIM을 넘으면 그 비율만큼 축소 (이미 작으면 축소하지 않음)
    const scale = Math.min(1, DETECT_MAX_DIM / Math.max(srcMat.cols, srcMat.rows));

    // 사용할 메모리 사전 할당
    const gray = new cv.Mat();
    const resized = scale < 1 ? new cv.Mat() : null;
    const denoised = new cv.Mat();
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const closed = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const hull = new cv.Mat();
    let kernel: cv.Mat | null = null;

    let documentContour: cv.Mat | null = null;

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

        // 2. 점 노이즈 제거 → 약한 가우시안 (잡음성 edge는 억제, 큰 경계·코너는 유지)
        cv.medianBlur(detectSrc, denoised, MEDIAN_BLUR);
        cv.GaussianBlur(denoised, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

        // 3. 캐니 엣지 검출
        cv.Canny(blurred, edges, 75, 200);

        // 4. 끊긴 경계 잇기: 글레어/조명으로 베젤 edge가 조각나면 컨투어가 갈라지므로
        //    모폴로지 닫힘(팽창→침식)으로 작은 틈을 메운다.
        kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(CLOSE_KERNEL, CLOSE_KERNEL));
        cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);

        // 5. 윤곽선 찾기 (외곽만)
        cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        // 6. 가장 큰 컨투어 하나 선택 (문서/화면 경계일 확률이 가장 높음)
        //    면적 기준(1000)은 축소 좌표계 기준이라 scale^2만큼 줄여 원본 기준과 맞춘다.
        const minArea = 1000 * scale * scale;
        let biggest: cv.Mat | null = null;
        let biggestArea = 0;
        for (let i = 0; i < contours.size(); i++) {
            const c = contours.get(i);
            const area = cv.contourArea(c);
            if (area > minArea && area > biggestArea) {
                if (biggest) biggest.delete(); // 교체되는 이전 후보 해제
                biggest = c;
                biggestArea = area;
            } else {
                c.delete();
            }
        }

        // 7. 볼록껍질 → x±y 극값으로 코너 4점 추출
        if (biggest) {
            cv.convexHull(biggest, hull, false, true);
            const corners = pickCorners(hull);
            biggest.delete();

            if (corners) {
                // 원본 좌표계로 복원
                const inv = scale < 1 ? 1 / scale : 1;
                const origCorners: Point[] = corners.map((p) => ({
                    x: Math.round(p.x * inv),
                    y: Math.round(p.y * inv),
                }));

                // 8. 면적 비율 체크 (프레임 밖으로 잘려 작은 조각이 잡힌 경우 배제)
                const imageArea = srcMat.cols * srcMat.rows;
                const ratio = quadArea(origCorners) / imageArea;

                if (ratio >= MIN_AREA_RATIO) {
                    const flat: number[] = [];
                    for (const p of origCorners) flat.push(p.x, p.y);
                    // 반환 형태는 기존과 동일한 4x1 CV_32SC2 Mat (TL,TR,BR,BL 순서)
                    documentContour = cv.matFromArray(4, 1, cv.CV_32SC2, flat);
                } else {
                    console.warn(
                        `검출된 영역이 전체 이미지의 ${(ratio * 100).toFixed(1)}%로 너무 작습니다 ` +
                        `(최소 ${(MIN_AREA_RATIO * 100).toFixed(0)}% 필요). 문서 테두리가 프레임 밖으로 잘렸을 수 있습니다.`
                    );
                }
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
        denoised.delete();
        blurred.delete();
        edges.delete();
        closed.delete();
        contours.delete();
        hierarchy.delete();
        hull.delete();
        kernel?.delete();
    }
}
// export async function detectDocument(srcMat: cv.Mat): Promise<cv.Mat | null> {
//     // OpenCV.js WASM 런타임이 준비된 이후에만 cv.* API를 사용할 수 있다.
//     const cv = await ensureCv();

//     // 긴 변이 DETECT_MAX_DIM을 넘으면 그 비율만큼 축소 (이미 작으면 축소하지 않음)
//     const scale = Math.min(1, DETECT_MAX_DIM / Math.max(srcMat.cols, srcMat.rows));

//     // 사용할 메모리 사전 할당
//     const gray = new cv.Mat();
//     const resized = scale < 1 ? new cv.Mat() : null;
//     const blurred = new cv.Mat();
//     const denoised = new cv.Mat();
//     const edges = new cv.Mat();
//     const contours = new cv.MatVector();
//     const hierarchy = new cv.Mat();

//     let documentContour: cv.Mat | null = null;
//     let maxArea = 0;

//     try {
//         // 1. 흑백 변환
//         cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY, 0);

//         // 1-1. 검출용 축소 (있는 경우)
//         let detectSrc = gray;
//         if (resized) {
//             const dsize = new cv.Size(Math.round(srcMat.cols * scale), Math.round(srcMat.rows * scale));
//             cv.resize(gray, resized, dsize, 0, 0, cv.INTER_AREA);
//             detectSrc = resized;
//         }

//         cv.medianBlur(detectSrc, denoised, MEDIAN_BLUR);

//         // 2. 가우시안 블러 (5x5 커널 사용, 노이즈 제거)
//         const ksize = new cv.Size(5, 5);
//         cv.GaussianBlur(denoised, blurred, ksize, 0, 0, cv.BORDER_DEFAULT);

//         // 3. 캐니 엣지 검출 (윤곽선 뚜렷하게)
//         cv.Canny(blurred, edges, 75, 200);

//         // 4. 윤곽선 찾기
//         cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

//         // 5. 가장 큰 4각형 윤곽선 찾기
//         // 면적 기준(1000)은 축소된 좌표계 기준이므로 scale^2만큼 같이 줄여 원본 기준과 동등하게 맞춘다.
//         const minArea = 1000 * scale * scale;
//         for (let i = 0; i < contours.size(); ++i) {
//             const contour = contours.get(i);
//             const area = cv.contourArea(contour);

//             if (area > minArea) {
//                 // 윤곽선의 둘레 길이 계산
//                 const perimeter = cv.arcLength(contour, true);
//                 const approx = new cv.Mat();

//                 // 다각형으로 근사화 (둘레의 2% 오차 허용)
//                 cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

//                 // 꼭짓점이 4개이고, 지금까지 찾은 면적보다 큰 경우
//                 if (approx.rows === 4 && area > maxArea) {
//                     // 이전 데이터가 있으면 메모리 해제
//                     if (documentContour) documentContour.delete();

//                     documentContour = approx.clone(); // 복사해서 저장
//                     maxArea = area;
//                 }
//                 approx.delete();
//             }
//             contour.delete();
//         }

//         // 축소된 좌표계에서 찾았다면 원본 좌표계로 되돌린다.
//         if (documentContour && scale < 1) {
//             const data = documentContour.data32S;
//             for (let i = 0; i < data.length; i++) {
//                 data[i] = Math.round(data[i] / scale);
//             }
//         }

//         // 전체 이미지 대비 너무 작은 영역이면(= 목표 문서가 프레임 밖으로 잘려서
//         // 그 안의 작은 조각이 오검출됐을 가능성이 높음) 검출 실패로 처리한다.
//         if (documentContour) {
//             const originalArea = maxArea / (scale * scale);
//             const imageArea = srcMat.cols * srcMat.rows;
//             if (originalArea / imageArea < MIN_AREA_RATIO) {
//                 console.warn(
//                     `검출된 영역이 전체 이미지의 ${(originalArea / imageArea * 100).toFixed(1)}%로 너무 작습니다 ` +
//                     `(최소 ${(MIN_AREA_RATIO * 100).toFixed(0)}% 필요). 문서 테두리가 사진 프레임 밖으로 잘렸을 수 있습니다.`
//                 );
//                 documentContour.delete();
//                 documentContour = null;
//             }
//         }

//         return documentContour;

//     } catch (error) {
//         console.error('검출 중 오류 발생:', error);
//         return null;
//     } finally {
//         // [중요] C++ WebAssembly 기반이므로 사용이 끝난 메모리는 직접 해제해야 함
//         gray.delete();
//         resized?.delete();
//         denoised.delete();
//         blurred.delete();
//         edges.delete();
//         contours.delete();
//         hierarchy.delete();
//     }
// }

export interface ScanPlan {
    decision: PreprocessDecision;
    documentContour: cv.Mat | null;
}
export async function planScan(srcMat: cv.Mat): Promise<ScanPlan> {
    const decision = await analyzeImage(srcMat);

    // 깨끗본이면 기하 보정 불필요 → 문서 검출 스킵
    if (decision.isClean) {
        return { decision, documentContour: null };
    }

    // 원근 또는 기울기가 필요할 때만 문서 4각형 검출
    let documentContour: cv.Mat | null = null;
    if (decision.steps.perspective || decision.steps.deskew) {
        documentContour = await detectDocument(srcMat);
    }

    return { decision, documentContour };
}