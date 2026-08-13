# OCR Preprocessing (TypeScript)

카메라로 찍은 문서(종이/화면) 이미지를, 텍스트 줄 방향을 기준으로 회전(기울기) 보정해서 OCR이 조금 더 읽기 편한 상태로 만들어주는 모듈입니다.
기존 프로젝트에서는 **`warpImage()` 함수 하나만 호출**하면 됩니다.

### 왜 "사각형을 찾아 잘라내는" 방식(원근 변환)을 쓰지 않는가

이전 버전은 Canny 엣지로 문서 사각형을 찾아 그 4개 꼭짓점 기준으로 원근 변환(관점 보정)을 적용했습니다. 하지만 이 방식은 이 프로젝트의 목적(OCR 전처리)과 근본적으로 안 맞는 리스크가 있습니다:

- **사각형 검출은 실패할 수 있고, 실패하면 문서 안의 표/여백을 잘못 잡아 크롭합니다.** 그 결과 전처리 없이 OCR을 돌렸다면 인식됐을 내용이, 전처리 단계에서 통째로 잘려나가 버릴 수 있습니다.
- 전처리는 "안 해도 되는데 굳이 해서 상황을 악화시키면" 안 됩니다. 전처리 없이 원본 그대로 OCR에 넘기는 게 기준선(baseline)인데, 크롭은 이 기준선보다 나빠질 위험(내용 소실)이 있는 반면, **회전 보정은 캔버스를 확장해서 적용하므로 원본 내용을 절대 잘라내지 않습니다** — 최악의 경우에도 "보정이 덜 됨"이지 "내용이 사라짐"은 아닙니다.
- 다만 트레이드오프도 있습니다: 회전 보정은 평면 내 기울기(2D 회전)만 고칠 뿐, 카메라를 비스듬히 들고 찍어서 생기는 진짜 3D 원근(사다리꼴) 왜곡까지는 펴주지 못합니다. "내용을 안전하게 보존하는 것"을 "완벽하게 정면으로 펴는 것"보다 우선한 설계입니다.

(참고: 사각형 검출 + 원근 변환 코드 자체는 `src/scanner.ts`, `src/warping.ts`에 그대로 남아있지만 `warpImage()`는 더 이상 이를 호출하지 않습니다. 프로젝트 구조 섹션 참고.)

## 사용법 (기존 프로젝트에 통합)

```ts
import { warpImage } from './index.js';

const { success, method, image } = await warpImage('/path/to/photo.jpg');
// success: 회전 보정이 적용됐으면 true
// method : 'deskew' | 'original' — 실제로 적용된 보정 방식
// image  : 결과 이미지 (JPEG, "data:image/jpeg;base64,..." 형식의 base64 data URL)
```

파일로 저장하지 않고 결과를 base64 문자열로 바로 반환하므로, 파일 시스템 접근 없이 API 응답 등에 그대로 실어 보낼 수 있습니다.

### API

```ts
interface WarpResult {
    success: boolean;
    method: 'deskew' | 'original';
    image: string; // "data:image/jpeg;base64,..." 형식
}

function warpImage(inputPath: string): Promise<WarpResult>
```

| 항목 | 설명 |
| --- | --- |
| 인자 | `inputPath` — 입력 이미지 파일 경로 (문자열 하나) |
| 동작 | 이미지 디코딩 → 텍스트 줄 기준 회전 보정(deskew) 시도 → JPEG로 인코딩해 base64 반환 |
| 반환값 | `{ success, method, image }` — `image`는 base64 data URL, 파일로 저장하지 않음 |
| `method` | `'deskew'`: 회전 보정을 적용함(크롭 없음). `'original'`: 기울기가 미미했거나 보정이 실패해 원본 그대로 반환 |
| `success` | `method`가 `'deskew'`이면 `true` |
| 실패 시 (`method: 'original'`) | 어떤 경우에도 throw하지 않고 원본 이미지를 그대로 반환합니다. 이때만 `console.error`로 `{ success: false, reason, inputPath }` 형태의 JSON을 로그로 남깁니다. `image`(base64)는 남기지 않습니다 — 실패 하나당 수백 KB라 로그가 금방 못 읽을 정도로 길어지고, 호출부가 넘긴 `inputPath`로 원본을 직접 열어보면 되기 때문입니다 |

호출 시 콘솔에 아래 두 줄의 처리 시간이 함께 출력됩니다 (성능 비교/디버깅용, 추후 삭제 예정).
```text
순수 연산 시간 (회전 보정): 000.0ms
처리 시간 (연산 + base64 인코딩, 입력 로드 제외): 000.0ms
```

### 의존성

```bash
npm install @techstark/opencv-js sharp
```

> 이미지 디코딩/인코딩에 [jimp](https://www.npmjs.com/package/jimp) 대신 **[sharp](https://sharp.pixelplumbing.com/)**(네이티브 libvips 바인딩)를 사용합니다. 같은 4000×3000 JPG 기준 디코딩 6배, 인코딩 20배가량 빠릅니다. 단, 네이티브 바이너리를 포함하므로 설치 용량이 조금 더 크고, 플랫폼(OS/CPU)에 맞는 프리빌드 바이너리를 내려받습니다.

## 단독 실행 (테스트용)

이 저장소를 그대로 CLI로 실행해 결과를 확인할 수도 있습니다.

```bash
npm install
npm run dev <입력 이미지 경로>
# 예: npm run dev example.jpg  ->  example_warp.jpg 생성
```

빌드 후 실행:
```bash
npm run build
npm start <입력 이미지 경로>
```

## 프로젝트 구조

```text
internship/
├── src/
│   ├── index.ts      # 통합 진입점 — warpImage() 제공 + 단독 실행용 CLI (sharp 기반 이미지 I/O)
│   ├── deskew.ts     # 텍스트 줄 기준 회전 보정 — Projection Profile 방식 (현재 파이프라인이 사용하는 유일한 보정 로직)
│   ├── scanner.ts    # (미사용) 문서 외곽선 검출 — Canny Edge, PolyDP, 사각형 형태/내용물 검증
│   ├── warping.ts    # (미사용) 검출된 외곽선 기준 원근 변환
│   └── cvReady.ts    # OpenCV.js(WASM) 초기화 및 캐싱
├── scripts/
│   └── testEdiSamples.ts  # samples/edi의 PDF 전체 페이지를 렌더링해 warpImage()를 돌려보는 배치 테스트 (npm run test:edi)
├── tsconfig.json     # TypeScript 컴파일러 설정
└── package.json      # 의존성 및 스크립트 설정
```

`scanner.ts`/`warping.ts`(사각형 검출 + 원근 변환)는 코드가 그대로 남아있지만 `index.ts`가 더 이상 호출하지 않습니다. OCR 전처리에서는 크롭으로 인한 내용 소실 위험이 회전 보정의 이점보다 크다고 판단해 뺐습니다 — 위 "왜 사각형을 찾아 잘라내는 방식을 쓰지 않는가" 참고. 필요해지면 `index.ts`에서 다시 연결할 수 있습니다.

내부 동작(회전 각도 추정 로직, 메모리 관리 등)을 수정해야 한다면 `deskew.ts`를 참고하세요. `cv.Mat`을 입출력으로 사용하므로 OpenCV.js WASM 메모리 해제 규칙을 따릅니다.

## 성능 관련 참고 사항

- **EXIF 방향 처리**: 휴대폰/카메라로 찍은 사진은 EXIF `Orientation` 태그로 회전 정보가 별도로 저장되는 경우가 많습니다. `index.ts`에서 `sharp(...).rotate()`를 호출해 이 태그를 반영한 뒤 픽셀을 읽으므로, 회전된 채로 저장된 원본도 화면에 보이는 방향 그대로 처리됩니다.
- **회전 보정 (`deskew.ts`, Projection Profile 방식)**: 흑백 이진화한 이미지를 후보 각도(-15°~+15°, 0.5° 간격)만큼 돌려가며 가로 투영(각 행의 픽셀 합) 분산이 최대가 되는 각도를 찾아 그 각도만큼 회전합니다. 문서가 똑바로 섰을 때 텍스트 줄과 여백이 뚜렷이 갈려 분산이 최대가 된다는 원리(Postl's algorithm)를 이용합니다. `cv.warpAffine`으로 회전할 때 캔버스를 원본보다 넉넉하게 확장해서 적용하므로 크롭이 전혀 없습니다. 추정 각도가 0.3도 미만이면 이미 반듯하다고 보고 회전을 적용하지 않습니다.
- **`deskewImage()`의 실패 신호 전달**: `{ mat, applied, angle, reason }`을 반환합니다. `mat`은 항상 유효한 값이 채워지므로(실패 시 원본 복사본) 호출부에서 null 체크에 시달릴 필요가 없고, 대신 `applied`/`reason`으로 실제 적용 여부와 사유를 명확히 알 수 있습니다. 내부에서 `console.warn`/`console.error`로 직접 로그를 남기지 않고 `reason`을 호출부(`warpImage()`)에 전달하기만 합니다 — 로그는 `warpImage()` 한 곳에서 통일해서 남깁니다 (`method: 'original'`일 때만 `inputPath` 포함 JSON `console.error`).

### (미사용) `scanner.ts` / `warping.ts` 관련 참고 사항

지금은 `index.ts`가 호출하지 않지만, 코드는 남아있으므로 다시 연결할 경우를 위해 남겨둡니다.

- **검출 단계 다운스케일**: 원본 해상도 그대로 Canny/findContours를 돌리면 느리기 때문에, 이미지의 긴 변이 `DETECT_MAX_DIM`(2000px)을 넘으면 축소본에서 검출한 뒤 좌표만 원본 스케일로 환산합니다. 이 값을 더 낮추면 (예: 1600 이하) 배경의 작은 사각형을 문서로 오검출하는 사례가 확인되어, 2000을 하한으로 유지하고 있습니다.
- **잘못된 촬영(재촬영 유도) 검출**: 검출된 4각형이 전체 이미지 면적의 `MIN_AREA_RATIO`(5%) 미만이면 검출 실패로 처리합니다.
- **사각형 형태 검증**: `approxPolyDP`로 찾은 4개 꼭짓점이 "면적이 가장 크다"는 이유만으로 채택되지 않도록, `isPlausibleDocumentQuad()`가 convex 여부·내각(65~115도)·변 길이 비율(최대 4배)·종횡비(최대 4배)를 추가로 검사합니다.
- **사각형 내용물 검증**: 모양 검증만으로는 부족한 경우가 있습니다 — 표의 빈 칸이나 문서 여백처럼 경계선은 완벽한 직사각형이지만 내부가 텅 빈 영역도 있기 때문입니다(실제로 표 안의 빈 칸이 "문서"로 오검출되어, 원근 변환 결과 이미지에 아무 내용도 없이 흰 배경만 남는 사고가 있었습니다). `hasEnoughContent()`가 후보 사각형 내부의 명도 표준편차를 계산해 `MIN_CONTENT_STDDEV`(8) 미만이면(= 텍스트/선 등 실제 내용이 거의 없으면) 거부합니다.
- 위 두 검증에도 불구하고, 결국 "크롭 자체가 위험하다"는 결론(README 상단 참고)으로 `warpImage()`에서는 사용하지 않기로 했습니다.