import cv from '@techstark/opencv-js';
import { ensureCv } from './cvReady.js';

// 각도 추정용 다운스케일 기준. scanner.ts의 DETECT_MAX_DIM과 같은 이유로,
// 원본 해상도 그대로 여러 후보 각도를 반복 계산하면 느리므로 축소본에서 각도만 찾는다.
const ANGLE_ESTIMATE_MAX_DIM = 1000;

// 후보 각도 범위(±)와 간격. 문서 촬영에서 흔히 발생하는 수준의 삐딱함(15도 이내)만
// 다룬다 — 그 이상 기울어졌다면 애초에 다시 촬영을 유도해야 하는 수준이라 범위를 넓히지 않는다.
const ANGLE_RANGE_DEG = 15;
const ANGLE_STEP_DEG = 0.5;

// 추정된 각도가 이 값 미만이면 보정할 필요가 없다고 보고 회전을 적용하지 않는다.
const MIN_MEANINGFUL_ANGLE_DEG = 0.3;

/**
 * deskewImage()의 반환 타입.
 * - mat: 항상 유효하다 — 보정 적용 시 회전된 이미지(크롭 없이 캔버스 확장), 아니면 srcMat의 복사본.
 * - applied: 실제로 회전을 적용했는지 여부.
 * - angle: 추정된 회전각(도). applied가 false면 참고용일 뿐 적용되지 않은 값이다.
 * - reason: applied가 false일 때, 적용하지 않은 이유.
 */
export interface DeskewResult {
    mat: cv.Mat;
    applied: boolean;
    angle: number;
    reason?: string;
}

/**
 * 이진화된 흑백 이미지를 주어진 각도로 회전했을 때, 가로 투영(각 행의 픽셀 합) 분산을 계산한다.
 * 문서가 똑바로 섰을 때(텍스트 줄과 여백이 뚜렷이 갈릴 때) 이 분산이 최대가 된다는
 * Projection Profile 방법(Postl's algorithm)의 핵심 아이디어.
 */
function projectionVarianceAt(cvHandle: typeof cv, binary: cv.Mat, angleDeg: number): number {
    const center = new cvHandle.Point(binary.cols / 2, binary.rows / 2);
    const rotationMatrix = cvHandle.getRotationMatrix2D(center, angleDeg, 1);
    const rotated = new cvHandle.Mat();
    const rowSums = new cvHandle.Mat();

    try {
        cvHandle.warpAffine(
            binary,
            rotated,
            rotationMatrix,
            new cvHandle.Size(binary.cols, binary.rows),
            cvHandle.INTER_NEAREST,
            cvHandle.BORDER_CONSTANT,
            new cvHandle.Scalar()
        );

        // dim=1: 각 행을 하나의 값으로 합쳐 세로로 긴 열벡터(행 개수 x 1)를 만든다 = 가로 투영.
        // REDUCE_SUM은 이 패키지의 타입 정의에 빠져 있어(런타임에는 존재) any로 접근한다.
        cvHandle.reduce(rotated, rowSums, 1, (cvHandle as any).REDUCE_SUM, cvHandle.CV_32S);

        const data = rowSums.data32S;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const mean = sum / data.length;

        let variance = 0;
        for (let i = 0; i < data.length; i++) {
            const diff = data[i] - mean;
            variance += diff * diff;
        }
        return variance / data.length;
    } finally {
        rotationMatrix.delete();
        rotated.delete();
        rowSums.delete();
    }
}

/**
 * Projection Profile 방식으로 문서의 회전 기울기(skew)를 추정한다.
 * @param grayMat 흑백(1채널) 이미지
 * @returns 추정된 회전각(도)
 */
function estimateSkewAngle(cvHandle: typeof cv, grayMat: cv.Mat): number {
    const binary = new cvHandle.Mat();

    try {
        // Otsu 이진화 + 반전(INV): 배경(밝음)을 0, 텍스트/내용(어두움)을 255로 만들어야
        // reduce(SUM) 결과가 텍스트 줄이 있는 행에서 크게 튀어 분산이 뚜렷해진다.
        cvHandle.threshold(grayMat, binary, 0, 255, cvHandle.THRESH_BINARY_INV + cvHandle.THRESH_OTSU);

        let bestAngle = 0;
        let bestVariance = -Infinity;
        for (let angle = -ANGLE_RANGE_DEG; angle <= ANGLE_RANGE_DEG; angle += ANGLE_STEP_DEG) {
            const variance = projectionVarianceAt(cvHandle, binary, angle);
            if (variance > bestVariance) {
                bestVariance = variance;
                bestAngle = angle;
            }
        }
        return bestAngle;
    } finally {
        binary.delete();
    }
}

/**
 * 문서 사각형 검출/원근 변환에 실패했을 때 쓰는 폴백. 문서 외곽을 몰라도, 텍스트 줄
 * 방향을 기준으로 회전(스큐)만 보정한다. 원근 변환과 달리 캔버스를 확장해서 회전하므로
 * 내용을 절대 잘라내지 않는다 — "사각형을 잘못 인식해서 내용이 누락"되는 실패 모드가
 * 구조적으로 발생할 수 없다.
 *
 * @param srcMat 원본 이미지 (cv.Mat)
 * @returns { mat, applied, angle, reason } — mat은 실패 시에도 srcMat의 복사본으로 항상 채워진다
 */
export async function deskewImage(srcMat: cv.Mat): Promise<DeskewResult> {
    const cvHandle = await ensureCv();

    let gray: cv.Mat | null = null;
    let resized: cv.Mat | null = null;

    try {
        gray = new cvHandle.Mat();
        cvHandle.cvtColor(srcMat, gray, cvHandle.COLOR_RGBA2GRAY, 0);

        const scale = Math.min(1, ANGLE_ESTIMATE_MAX_DIM / Math.max(srcMat.cols, srcMat.rows));
        let angleSrc = gray;
        if (scale < 1) {
            resized = new cvHandle.Mat();
            const dsize = new cvHandle.Size(Math.round(srcMat.cols * scale), Math.round(srcMat.rows * scale));
            cvHandle.resize(gray, resized, dsize, 0, 0, cvHandle.INTER_AREA);
            angleSrc = resized;
        }

        const angle = estimateSkewAngle(cvHandle, angleSrc);

        if (Math.abs(angle) < MIN_MEANINGFUL_ANGLE_DEG) {
            return {
                mat: srcMat.clone(),
                applied: false,
                angle,
                reason: `추정된 기울기(${angle.toFixed(1)}도)가 미미해 회전을 적용하지 않았습니다.`,
            };
        }

        // 캔버스를 확장해서 회전 — 절대 크롭하지 않는다.
        const radians = (angle * Math.PI) / 180;
        const cos = Math.abs(Math.cos(radians));
        const sin = Math.abs(Math.sin(radians));
        const newWidth = Math.round(srcMat.cols * cos + srcMat.rows * sin);
        const newHeight = Math.round(srcMat.cols * sin + srcMat.rows * cos);

        const center = new cvHandle.Point(srcMat.cols / 2, srcMat.rows / 2);
        const rotationMatrix = cvHandle.getRotationMatrix2D(center, angle, 1);
        // 회전 중심을 확장된 새 캔버스의 중심으로 옮기도록 이동(translation) 성분을 보정한다.
        rotationMatrix.data64F[2] += newWidth / 2 - center.x;
        rotationMatrix.data64F[5] += newHeight / 2 - center.y;

        const dst = new cvHandle.Mat();
        try {
            cvHandle.warpAffine(
                srcMat,
                dst,
                rotationMatrix,
                new cvHandle.Size(newWidth, newHeight),
                cvHandle.INTER_LINEAR,
                cvHandle.BORDER_CONSTANT,
                new cvHandle.Scalar()
            );
        } finally {
            rotationMatrix.delete();
        }

        return { mat: dst, applied: true, angle };
    } catch (error) {
        return {
            mat: srcMat.clone(),
            applied: false,
            angle: 0,
            reason: `스큐 보정 중 오류 발생: ${error instanceof Error ? error.message : String(error)}`,
        };
    } finally {
        gray?.delete();
        resized?.delete();
    }
}
