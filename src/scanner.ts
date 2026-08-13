import cv from '@techstark/opencv-js';
import { ensureCv } from './cvReady.js';

// 윤곽선 검출용 축소 기준 크기. Canny/findContours 비용은 픽셀 수에 비례하므로
// 검출 단계에서만 이 크기로 축소해 연산량을 줄이고, 찾은 좌표는 원본 스케일로 되돌린다.
// (2000 미만으로 더 줄이면 이 프로젝트 샘플 사진 기준으로 배경의 작은 사각형을
//  문서로 오검출하는 경우가 있어 2000을 하한으로 둔다.)
const DETECT_MAX_DIM = 2000;

// 검출된 4각형이 전체 이미지 면적에서 차지해야 하는 최소 비율.
// 목표 문서(종이/화면)의 테두리 일부가 사진 프레임 밖으로 잘려 나가면, 실제로는
// 문서 안의 작은 표/칸 하나가 "우연히 프레임 안에서 닫힌 가장 큰 4각형"이 되어
// 오검출되는 경우가 있다. 이런 경우를 걸러내기 위한 하한선.
const MIN_AREA_RATIO = 0.05;

// 아래 네 상수는 "그럴듯한 문서 사각형"인지 걸러내는 형태 검증 기준이다.
// 배경의 표/창틀/그림자 경계 등 우연히 닫힌 4각형이 잡히는 경우, 실제 문서와
// 달리 마름모꼴로 찌그러져 있거나(각도), 한쪽으로 지나치게 길쭉한(변 비율/종횡비)
// 경우가 많아 이 기준으로 상당수 오검출을 걸러낼 수 있다.
const MIN_CORNER_ANGLE_DEG = 65;
const MAX_CORNER_ANGLE_DEG = 115;
const MAX_SIDE_RATIO = 4; // 가장 긴 변 / 가장 짧은 변
const MAX_ASPECT_RATIO = 4; // 문서 가로/세로(또는 세로/가로) 비율

/**
 * approxPolyDP가 찾은 4개 꼭짓점이 실제 문서(종이/화면)로 그럴듯한 모양인지 검증한다.
 * 볼록(convex)하지 않거나, 내각이 직각에서 크게 벗어나거나, 변의 길이 편차가 심하거나,
 * 종횡비가 비정상적으로 길쭉하면 배경 노이즈를 잘못 잡은 것으로 보고 거부한다.
 */
function isPlausibleDocumentQuad(cv: any, approx: cv.Mat): boolean {
    if (!cv.isContourConvex(approx)) return false;

    const data = approx.data32S;
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < 4; i++) {
        points.push({ x: data[i * 2], y: data[i * 2 + 1] });
    }

    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    // 순서대로 이어진 변 4개: (0,1) (1,2) (2,3) (3,0)
    const sides = [0, 1, 2, 3].map((i) => dist(points[i], points[(i + 1) % 4]));

    const maxSide = Math.max(...sides);
    const minSide = Math.min(...sides);
    if (minSide === 0 || maxSide / minSide > MAX_SIDE_RATIO) return false;

    const angleAt = (prev: { x: number; y: number }, curr: { x: number; y: number }, next: { x: number; y: number }) => {
        const v1 = { x: prev.x - curr.x, y: prev.y - curr.y };
        const v2 = { x: next.x - curr.x, y: next.y - curr.y };
        const mag1 = Math.hypot(v1.x, v1.y);
        const mag2 = Math.hypot(v2.x, v2.y);
        if (mag1 === 0 || mag2 === 0) return 0;
        const cos = Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / (mag1 * mag2)));
        return (Math.acos(cos) * 180) / Math.PI;
    };

    for (let i = 0; i < 4; i++) {
        const angle = angleAt(points[(i + 3) % 4], points[i], points[(i + 1) % 4]);
        if (angle < MIN_CORNER_ANGLE_DEG || angle > MAX_CORNER_ANGLE_DEG) return false;
    }

    // 마주보는 변끼리 평균 내어 가로/세로 길이를 추정한다: (0,1)-(2,3)이 한 쌍, (1,2)-(3,0)이 한 쌍.
    const width = (sides[0] + sides[2]) / 2;
    const height = (sides[1] + sides[3]) / 2;
    const aspect = Math.max(width, height) / Math.min(width, height);
    if (aspect > MAX_ASPECT_RATIO) return false;

    return true;
}

// 후보 사각형 내부에 실제 내용(텍스트/선/그림 등)이 있는지 검사하는 최소 명도 표준편차 기준.
// 표의 빈 칸이나 문서 여백처럼 기하학적으로는 완벽한 사각형(볼록·직각·정상 종횡비)이어도
// 내부가 텅 비어 있으면 아무 정보도 담지 못한 채 원근 변환만 적용되는 사고가 생긴다.
// 배경만 있으면 명도 표준편차가 거의 0에 가깝고, 텍스트/선이 있으면 명암 대비로 확연히 커진다.
const MIN_CONTENT_STDDEV = 8;

/**
 * 후보 사각형 내부(마스크 영역)의 명도 표준편차를 검사해, 실제 내용이 있는지 확인한다.
 * @param grayMat approx와 같은 좌표계(검출 스케일)의 흑백 이미지
 */
function hasEnoughContent(cv: any, grayMat: cv.Mat, approx: cv.Mat): boolean {
    const mask = cv.Mat.zeros(grayMat.rows, grayMat.cols, cv.CV_8UC1);
    const contourVec = new cv.MatVector();
    const mean = new cv.Mat();
    const stddev = new cv.Mat();

    try {
        contourVec.push_back(approx);
        cv.fillPoly(mask, contourVec, new cv.Scalar(255));
        cv.meanStdDev(grayMat, mean, stddev, mask);
        return stddev.data64F[0] >= MIN_CONTENT_STDDEV;
    } finally {
        mask.delete();
        contourVec.delete();
        mean.delete();
        stddev.delete();
    }
}

/**
 * detectDocument()의 반환 타입.
 * - contour: 검출된 4개 꼭짓점 좌표 (cv.Mat). 실패 시 null.
 * - reason: contour가 null일 때, 실패 이유. 호출부(index.ts)가 JSON 로그를 남길 때 사용한다.
 */
export interface DetectDocumentResult {
    contour: cv.Mat | null;
    reason?: string;
}

/**
 * 이미지에서 종이나 화면(가장 큰 사각형)의 4개 모서리 좌표를 찾습니다.
 * @param srcMat 원본 이미지 객체 (cv.Mat)
 * @returns { contour, reason } — 찾지 못했거나 전체 이미지 대비 너무 작으면 contour는 null
 */
export async function detectDocument(srcMat: cv.Mat): Promise<DetectDocumentResult> {
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

                // 꼭짓점이 4개이고, 지금까지 찾은 면적보다 크고, 문서로 그럴듯한 모양이면서
                // 실제 내용(텍스트/선 등)도 있는 경우 (모양만 맞고 속이 빈 표 칸 등을 배제)
                if (
                    approx.rows === 4 &&
                    area > maxArea &&
                    isPlausibleDocumentQuad(cv, approx) &&
                    hasEnoughContent(cv, detectSrc, approx)
                ) {
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

        // 전체 이미지 대비 너무 작은 영역이면(= 목표 문서가 프레임 밖으로 잘려서
        // 그 안의 작은 조각이 오검출됐을 가능성이 높음) 검출 실패로 처리한다.
        if (documentContour) {
            const originalArea = maxArea / (scale * scale);
            const imageArea = srcMat.cols * srcMat.rows;
            if (originalArea / imageArea < MIN_AREA_RATIO) {
                const reason =
                    `검출된 영역이 전체 이미지의 ${(originalArea / imageArea * 100).toFixed(1)}%로 너무 작습니다 ` +
                    `(최소 ${(MIN_AREA_RATIO * 100).toFixed(0)}% 필요). 문서 테두리가 사진 프레임 밖으로 잘렸을 수 있습니다.`;
                documentContour.delete();
                documentContour = null;
                return { contour: null, reason };
            }
        }

        if (!documentContour) {
            return { contour: null, reason: '문서(사각형) 영역을 찾지 못했습니다.' };
        }

        return { contour: documentContour };

    } catch (error) {
        const reason = `검출 중 오류 발생: ${error instanceof Error ? error.message : String(error)}`;
        return { contour: null, reason };
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