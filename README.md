# OpenCV Document Scanner (TypeScript)

이미지에서 문서(종이/화면)의 외곽선을 검출해 원근 변환으로 반듯하게 펴고, OCR 전처리에 쓰기 좋게 만들어주는 모듈입니다.
기존 프로젝트에서는 **`warpImage()` 함수 하나만 호출**하면 됩니다.

문서 사각형을 못 찾는 사진(모니터 베젤이 프레임 밖으로 잘림, 종이와 배경의 명도 차이가 적음 등)이 오히려 더 흔하다는 점을 고려해, 2단계 파이프라인으로 동작합니다:
1. **원근 변환(perspective)**: 문서 사각형을 찾으면, 그 4개 꼭짓점 기준으로 원근 변환을 적용해 정면에서 본 것처럼 반듯하게 폅니다.
2. **회전 보정(deskew, 폴백)**: 사각형을 못 찾거나 원근 변환에 실패하면, 텍스트 줄 방향을 기준으로 회전(기울기)만 보정합니다. 원근 변환과 달리 **캔버스를 확장해서 회전하므로 내용을 절대 잘라내지 않습니다** — "사각형을 잘못 인식해서 문서 일부가 잘려나가는" 실패 모드가 구조적으로 발생할 수 없습니다.

## 사용법 (기존 프로젝트에 통합)

```ts
import { warpImage } from './index.js';

const { success, method, image } = await warpImage('/path/to/photo.jpg');
// success: 원근 변환 또는 회전 보정 중 하나라도 적용됐으면 true
// method : 'perspective' | 'deskew' | 'original' — 실제로 적용된 보정 방식
// image  : 결과 이미지 (JPEG, "data:image/jpeg;base64,..." 형식의 base64 data URL)
```

파일로 저장하지 않고 결과를 base64 문자열로 바로 반환하므로, 파일 시스템 접근 없이 API 응답 등에 그대로 실어 보낼 수 있습니다.

### API

```ts
interface WarpResult {
    success: boolean;
    method: 'perspective' | 'deskew' | 'original';
    image: string; // "data:image/jpeg;base64,..." 형식
}

function warpImage(inputPath: string): Promise<WarpResult>
```

| 항목 | 설명 |
| --- | --- |
| 인자 | `inputPath` — 입력 이미지 파일 경로 (문자열 하나) |
| 동작 | 이미지 디코딩 → (1단계) 문서 영역 검출 + 원근 변환 → 실패 시 (2단계) 텍스트 줄 기준 회전 보정 → JPEG로 인코딩해 base64 반환 |
| 반환값 | `{ success, method, image }` — `image`는 base64 data URL, 파일로 저장하지 않음 |
| `method` | `'perspective'`: 문서 사각형을 찾아 원근 변환까지 적용(가장 좋은 결과). `'deskew'`: 사각형을 못 찾아 회전만 보정(크롭 없음). `'original'`: 둘 다 적용되지 못해 원본 그대로 반환 |
| `success` | `method`가 `'original'`이 아니면 `true` (즉 원근 변환이든 회전 보정이든 뭔가 적용됐으면 성공으로 취급) |
| 실패 시 (`method: 'original'`) | 어떤 경우에도 throw하지 않고 원본 이미지를 그대로 반환합니다. 이때만 `console.error`로 `{ success: false, reason, image }` 형태의 JSON(실패 사유 + 원본 이미지 base64)을 로그로 남깁니다. `method: 'deskew'`로 폴백된 경우는 실패가 아니므로 `console.log`로 사유와 적용된 각도만 짧게 남깁니다 |

호출 시 콘솔에 아래 두 줄의 처리 시간이 함께 출력됩니다 (성능 비교/디버깅용, 추후 삭제 예정).
```text
순수 연산 시간 (엣지 검출 + 원근 변환): 000.0ms
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
│   ├── scanner.ts    # 문서 외곽선 검출 (Canny Edge, PolyDP, 사각형 형태 검증)
│   ├── warping.ts    # 검출된 외곽선 기준 원근 변환
│   ├── deskew.ts     # (폴백) 텍스트 줄 기준 회전 보정 — Projection Profile 방식
│   └── cvReady.ts    # OpenCV.js(WASM) 초기화 및 캐싱
├── scripts/
│   └── testEdiSamples.ts  # samples/edi의 PDF 전체 페이지를 렌더링해 warpImage()를 돌려보는 배치 테스트 (npm run test:edi)
├── tsconfig.json     # TypeScript 컴파일러 설정
└── package.json      # 의존성 및 스크립트 설정
```

내부 동작(검출 알고리즘 세부 로직, 메모리 관리 등)을 수정해야 한다면 `scanner.ts`(검출), `warping.ts`(원근 변환), `deskew.ts`(회전 보정 폴백)를 참고하세요. 세 파일 모두 `cv.Mat`을 입출력으로 사용하므로 OpenCV.js WASM 메모리 해제 규칙을 따릅니다.

## 성능 관련 참고 사항

- **`scanner.ts` 검출 단계 다운스케일**: 원본 해상도 그대로 Canny/findContours를 돌리면 느리기 때문에, 이미지의 긴 변이 `DETECT_MAX_DIM`(2000px)을 넘으면 축소본에서 검출한 뒤 좌표만 원본 스케일로 환산합니다. 이 값을 더 낮추면 (예: 1600 이하) 배경의 작은 사각형을 문서로 오검출하는 사례가 확인되어, 2000을 하한으로 유지하고 있습니다.
- **흑백 변환 후 리사이즈**: 컬러(4채널) 상태에서 리사이즈하는 것보다 흑백(1채널) 변환 후 리사이즈하는 쪽이 실측상 약 2배 빠릅니다.
- **EXIF 방향 처리**: 휴대폰/카메라로 찍은 사진은 EXIF `Orientation` 태그로 회전 정보가 별도로 저장되는 경우가 많습니다. `index.ts`에서 `sharp(...).rotate()`를 호출해 이 태그를 반영한 뒤 픽셀을 읽으므로, 회전된 채로 저장된 원본도 화면에 보이는 방향 그대로 처리됩니다.
- **잘못된 촬영(재촬영 유도) 검출**: 검출된 4각형이 전체 이미지 면적의 `MIN_AREA_RATIO`(5%) 미만이면 검출 실패로 처리합니다. 문서 테두리 일부가 사진 프레임 밖으로 잘려 나가면 문서 안의 작은 표/칸 하나가 "우연히 프레임 안에서 닫힌 가장 큰 4각형"으로 오검출되는 경우가 있는데, 이를 걸러내기 위한 하한선입니다. 이 경우에도 `warpImage()`는 throw하지 않고 원본 이미지를 그대로 반환합니다.
- **사각형 형태 검증**: `approxPolyDP`로 찾은 4개 꼭짓점이 "면적이 가장 크다"는 이유만으로 채택되지 않도록, `isPlausibleDocumentQuad()`가 convex 여부·내각(65~115도)·변 길이 비율(최대 4배)·종횡비(최대 4배)를 추가로 검사합니다. 배경의 창틀/그림자/표 경계처럼 우연히 닫힌 4각형이 실제 문서보다 먼저 선택되어 원근 변환이 엉뚱한 영역을 잘라내는 사고를 줄이기 위한 필터입니다.
- **사각형 내용물 검증**: 모양 검증만으로는 부족한 경우가 있습니다 — 표의 빈 칸이나 문서 여백처럼 경계선은 완벽한 직사각형이지만 내부가 텅 빈 영역도 있기 때문입니다(실제로 표 안의 빈 칸이 "문서"로 오검출되어, 원근 변환 결과 이미지에 아무 내용도 없이 흰 배경만 남는 사고가 있었습니다). `hasEnoughContent()`가 후보 사각형 내부의 명도 표준편차를 계산해 `MIN_CONTENT_STDDEV`(8) 미만이면(= 텍스트/선 등 실제 내용이 거의 없으면) 거부합니다.
- **회전 보정 폴백 (`deskew.ts`, Projection Profile 방식)**: 문서 사각형을 못 찾으면(대부분의 실사용 사진이 이 케이스), 흑백 이진화한 이미지를 후보 각도(-15°~+15°, 0.5° 간격)만큼 돌려가며 가로 투영(각 행의 픽셀 합) 분산이 최대가 되는 각도를 찾아 그 각도만큼 회전합니다. 문서가 똑바로 섰을 때 텍스트 줄과 여백이 뚜렷이 갈려 분산이 최대가 된다는 원리(Postl's algorithm)를 이용합니다. `cv.warpAffine`으로 회전할 때 캔버스를 원본보다 넉넉하게 확장해서 적용하므로 원근 변환과 달리 크롭이 전혀 없습니다. 추정 각도가 0.3도 미만이면 이미 반듯하다고 보고 회전을 적용하지 않습니다.
- **`detectDocument()` / `warpDocument()` / `deskewImage()`의 실패 신호 전달**: `detectDocument()`는 `{ contour, reason }`, `warpDocument()`는 `{ mat, success, reason }`, `deskewImage()`는 `{ mat, applied, angle, reason }`을 반환합니다. `mat`/`contour`(찾은 경우)는 항상 유효한 값이 채워지므로 호출부에서 null 체크에 시달릴 필요가 없고, 대신 `success`/`applied`/`reason`으로 실패 여부와 사유를 명확히 알 수 있습니다. 세 함수 모두 내부에서 `console.warn`/`console.error`로 직접 로그를 남기지 않고, 실패 사유를 `reason`으로 호출부(`warpImage()`)에 전달하기만 합니다 — 로그는 `warpImage()` 한 곳에서 통일해서 남깁니다 (`method: 'original'`일 때만 base64 포함 JSON `console.error`, `method: 'deskew'`일 때는 요약 `console.log`).