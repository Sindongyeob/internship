import cv from '@techstark/opencv-js';
import { ensureCv } from './cvReady.js';

/**
 * OCR 전처리 판별기 (preprocessing gate)
 *
 * 목적: 모든 이미지에 같은 전처리를 때리면 (1) 깨끗한 스캔본은 오히려 망가지고
 *       (2) 휴대폰 사진은 부족해진다. 그래서 이미지를 먼저 측정해서
 *       "전처리가 필요한지 / 필요하면 어느 단계가 필요한지"를 결정한다.
 *
 * 설계 원칙:
 *   - 전처리를 통째로 On/Off 하지 않고 단계별로 판별한다 (deskew / perspective /
 *     illumination / contrast / denoise 각각).
 *   - 여기서 나온 판정은 "이미지 통계 기반 사전 판별"이다. 가능하면 실제 OCR
 *     confidence 로 원본 vs 전처리본을 비교하는 "결과 기반" 방식을 뒤에 얹으면 더 안전하다.
 *   - 아래 임계값들은 시작점이며, 실제 샘플 데이터로 튜닝해야 한다.
 */

// ── 임계값 (실제 데이터로 튜닝 필요) ──────────────────────────────────

// 지오메트리 검출용 축소 크기 (연산량 절감, 판정엔 이 정도면 충분)
const ANALYZE_MAX_DIM = 1200;

// 선명도: 라플라시안 분산이 이 값 미만이면 "흐릿함"으로 본다.
const SHARPNESS_MIN = 100;

// 대비: 명암 동적범위(밝은부분 − 어두운부분)가 이 값 미만이면 "대비 부족(흐림/바램)"으로 본다.
// 주의: 전체 표준편차(std)는 여백 많은 문서에서 깨끗해도 낮게 나오므로 대비 지표로 부적합하다
//       (흰 바탕이 대부분이라 std 가 작음). 그래서 동적범위를 쓴다.
const DYN_RANGE_MIN = 120; // 0~255 스케일. 깨끗한 스캔은 배경~255, 글자~20 이라 200 이상 나온다.

// 조명 불균일도: 크게 다운샘플한 이미지의 변동계수(std/mean).
// 균일한 스캔은 낮고, 글레어/그림자 있는 사진은 높다.
const ILLUM_UNEVENNESS_MAX = 0.28;

// 채도: 컬러 사진(화면 촬영 등)은 채도/색번짐이 있고, 흑백 스캔은 채도가 낮다.
const SATURATION_MAX = 25; // 0~255 스케일의 S 채널 평균

// 기울기: 절대각이 이 값(도)을 넘으면 deskew 대상.
const SKEW_DEG_MAX = 2.0;

// 사각형 채움비: 검출된 문서 4각형이 자기 bounding box 를 채우는 비율.
// 축 정렬된 직사각형이면 ~1, 원근 왜곡되면 낮아진다.
const RECT_FILL_MIN = 0.92;

// 지오메트리 검출에서 무시할 최소 컨투어 면적 (축소 좌표계 기준)
const MIN_CONTOUR_AREA = 1000;

export interface PreprocessDecision {
    /** 종합 판정: 전처리가 하나라도 필요하면 true */
    needsPreprocess: boolean;
    /** 깨끗한 스캔/출력본으로 판단되면 true (needsPreprocess 의 반대에 가까움) */
    isClean: boolean;
    /** 휴대폰 사진 등 "촬영본"으로 추정되면 true */
    isPhoto: boolean;
    /** 단계별 필요 여부 */
    steps: {
        deskew: boolean;        // 기울기 보정
        perspective: boolean;   // 원근 보정 (문서 4각형이 비틀려 있음)
        illumination: boolean;  // 조명/그림자 정규화
        contrast: boolean;      // 대비 향상
        denoise: boolean;       // 노이즈 제거
    };
    /** 판정에 쓰인 측정값 (튜닝/디버깅용) */
    metrics: {
        sharpness: number;
        contrastStd: number;
        dynamicRange: number;
        illumUnevenness: number;
        saturation: number;
        skewDeg: number;
        docAreaRatio: number;
        rectFillRatio: number;
        docFound: boolean;
    };
    /** 사람이 읽을 수 있는 판정 근거 */
    reasons: string[];
}

/** 내부: 그레이 이미지의 최대 컨투어에서 지오메트리 지표 추출 */
function analyzeGeometry(
    cvns: typeof cv,
    gray: cv.Mat,
    imageArea: number,
): { skewDeg: number; docAreaRatio: number; rectFillRatio: number; docFound: boolean } {
    const blurred = new cvns.Mat();
    const edges = new cvns.Mat();
    const contours = new cvns.MatVector();
    const hierarchy = new cvns.Mat();

    let result = { skewDeg: 0, docAreaRatio: 1, rectFillRatio: 1, docFound: false };

    try {
        cvns.GaussianBlur(gray, blurred, new cvns.Size(5, 5), 0, 0, cvns.BORDER_DEFAULT);
        cvns.Canny(blurred, edges, 75, 200);
        cvns.findContours(edges, contours, hierarchy, cvns.RETR_LIST, cvns.CHAIN_APPROX_SIMPLE);

        let biggest: cv.Mat | null = null;
        let biggestArea = 0;
        for (let i = 0; i < contours.size(); i++) {
            const c = contours.get(i);
            const area = cvns.contourArea(c);
            if (area > MIN_CONTOUR_AREA && area > biggestArea) {
                if (biggest) biggest.delete();
                biggest = c;
                biggestArea = area;
            } else {
                c.delete();
            }
        }

        if (biggest) {
            // 기울기: 최소 외접 회전 사각형의 각도
            const rect = cvns.minAreaRect(biggest);
            let ang = rect.angle;
            if (ang < -45) ang += 90;
            else if (ang > 45) ang -= 90;

            // 사각형 채움비: 4각형 근사 면적 / 축 정렬 bounding box 면적
            const brect = cvns.boundingRect(biggest);
            const boxArea = brect.width * brect.height;
            const fill = boxArea > 0 ? biggestArea / boxArea : 1;

            result = {
                skewDeg: ang,
                docAreaRatio: imageArea > 0 ? biggestArea / imageArea : 1,
                rectFillRatio: Math.min(1, fill),
                docFound: true,
            };
            biggest.delete();
        }
    } finally {
        blurred.delete();
        edges.delete();
        contours.delete();
        hierarchy.delete();
    }
    return result;
}

/**
 * 이미지를 측정해 전처리 필요 여부를 판정한다.
 * @param srcMat 원본 이미지 (cv.Mat, RGBA 가정)
 */
export async function analyzeImage(srcMat: cv.Mat): Promise<PreprocessDecision> {
    const cvns = await ensureCv();

    const scale = Math.min(1, ANALYZE_MAX_DIM / Math.max(srcMat.cols, srcMat.rows));

    const gray = new cvns.Mat();
    const small = scale < 1 ? new cvns.Mat() : null;
    const lap = new cvns.Mat();
    const meanMat = new cvns.Mat();
    const stdMat = new cvns.Mat();
    const tiny = new cvns.Mat();
    const rgb = new cvns.Mat();
    const hsv = new cvns.Mat();
    const hsvCh = new cvns.MatVector();

    try {
        cvns.cvtColor(srcMat, gray, cvns.COLOR_RGBA2GRAY, 0);

        let g = gray;
        if (small) {
            const dsize = new cvns.Size(Math.round(srcMat.cols * scale), Math.round(srcMat.rows * scale));
            cvns.resize(gray, small, dsize, 0, 0, cvns.INTER_AREA);
            g = small;
        }

        // 1) 선명도 = 라플라시안 분산
        cvns.Laplacian(g, lap, cvns.CV_64F, 1, 1, 0, cvns.BORDER_DEFAULT);
        cvns.meanStdDev(lap, meanMat, stdMat);
        const lapStd = stdMat.doubleAt(0, 0);
        const sharpness = lapStd * lapStd;

        // 2) 대비 = 명암 동적범위 (밝은부분 − 어두운부분)
        //    중앙값 블러로 튀는 점(핫픽셀)을 제거한 뒤 최소/최대 밝기 차이를 본다.
        //    std 대신 이걸 쓰는 이유: 여백 많은 문서는 깨끗해도 std 가 낮기 때문.
        cvns.meanStdDev(g, meanMat, stdMat);
        const contrastStd = stdMat.doubleAt(0, 0); // 참고용으로만 보고
        const drMat = new cvns.Mat();
        cvns.medianBlur(g, drMat, 3);
        const mm = cvns.minMaxLoc(drMat);
        const dynamicRange = mm.maxVal - mm.minVal;
        drMat.delete();

        // 3) 조명 불균일도 = 크게 다운샘플한 이미지의 변동계수(std/mean)
        cvns.resize(g, tiny, new cvns.Size(24, 24), 0, 0, cvns.INTER_AREA);
        cvns.meanStdDev(tiny, meanMat, stdMat);
        const tinyMean = meanMat.doubleAt(0, 0);
        const tinyStd = stdMat.doubleAt(0, 0);
        const illumUnevenness = tinyMean > 1 ? tinyStd / tinyMean : 0;

        // 4) 채도 = HSV 의 S 채널 평균 (컬러 사진 vs 흑백 스캔 구분)
        cvns.cvtColor(srcMat, rgb, cvns.COLOR_RGBA2RGB, 0);
        cvns.cvtColor(rgb, hsv, cvns.COLOR_RGB2HSV, 0);
        cvns.split(hsv, hsvCh);
        cvns.meanStdDev(hsvCh.get(1), meanMat, stdMat);
        const saturation = meanMat.doubleAt(0, 0);

        // 5) 지오메트리 (기울기 / 문서 면적 / 사각형 채움비)
        const imageArea = (small ? small.cols * small.rows : gray.cols * gray.rows);
        const geo = analyzeGeometry(cvns, g, imageArea);

        // ── 판정 ────────────────────────────────
        // 핵심 원칙: "깨끗한 스캔/출력본" vs "휴대폰 촬영본"을 가르는 판정은
        //   레이아웃과 무관한 사진 고유 신호(채도 + 조명 균일도)로만 한다.
        //   문서 면적/대비 std/사각형 채움비 같은 지표는 스캔본 레이아웃(여백·분할표 등)에
        //   따라 요동쳐서 깨끗본을 오판하는 주범이므로 이 1차 판정에서 제외한다.
        const reasons: string[] = [];

        const metrics = {
            sharpness,
            contrastStd,
            dynamicRange,
            illumUnevenness,
            saturation,
            skewDeg: geo.skewDeg,
            docAreaRatio: geo.docAreaRatio,
            rectFillRatio: geo.rectFillRatio,
            docFound: geo.docFound,
        };

        const colorPhoto = saturation > SATURATION_MAX;
        const unevenLight = illumUnevenness > ILLUM_UNEVENNESS_MAX;
        const isPhoto = colorPhoto || unevenLight;

        if (colorPhoto) reasons.push(`채도 ${saturation.toFixed(0)} > ${SATURATION_MAX} → 컬러 촬영본`);
        if (unevenLight) reasons.push(`조명 불균일도 ${illumUnevenness.toFixed(2)} > ${ILLUM_UNEVENNESS_MAX} → 조명 얼룩(촬영본)`);
        if (sharpness < SHARPNESS_MIN) reasons.push(`선명도 ${sharpness.toFixed(0)} < ${SHARPNESS_MIN} → 흐릿함(품질 경고)`);

        // 깨끗본: 사진 신호가 없으면 전처리 전부 스킵
        if (!isPhoto) {
            reasons.push('채도·조명 모두 깨끗 → 스캔/출력본으로 판단, 전처리 생략 후 바로 OCR');
            return {
                needsPreprocess: false,
                isClean: true,
                isPhoto: false,
                steps: { deskew: false, perspective: false, illumination: false, contrast: false, denoise: false },
                metrics,
                reasons,
            };
        }

        // 촬영본인 경우에만 단계별 보정 판정 (여기선 레이아웃 의존 지표를 써도 안전함)
        const deskew = geo.docFound && Math.abs(geo.skewDeg) > SKEW_DEG_MAX;
        if (deskew) reasons.push(`기울기 ${geo.skewDeg.toFixed(1)}° > ${SKEW_DEG_MAX}° → deskew`);

        const perspective = geo.docFound && geo.rectFillRatio < RECT_FILL_MIN;
        if (perspective) reasons.push(`사각형 채움비 ${geo.rectFillRatio.toFixed(2)} < ${RECT_FILL_MIN} → 원근 보정`);

        const illumination = unevenLight;
        const contrast = dynamicRange < DYN_RANGE_MIN;
        if (contrast) reasons.push(`동적범위 ${dynamicRange.toFixed(0)} < ${DYN_RANGE_MIN} → 대비 향상`);

        const denoise = true; // 촬영본은 모아레/센서 노이즈 정리

        return {
            needsPreprocess: true,
            isClean: false,
            isPhoto: true,
            steps: { deskew, perspective, illumination, contrast, denoise },
            metrics,
            reasons,
        };
    } finally {
        gray.delete();
        small?.delete();
        lap.delete();
        meanMat.delete();
        stdMat.delete();
        tiny.delete();
        rgb.delete();
        hsv.delete();
        hsvCh.delete();
    }
}