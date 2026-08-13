# OpenCV Document Scanner (TypeScript)

이미지에서 문서(종이/화면)의 외곽선을 검출하고 원근 변환으로 반듯하게 펴주는 모듈입니다.
기존 프로젝트에서는 **`warpImage()` 함수 하나만 호출**하면 됩니다.

## 사용법 (기존 프로젝트에 통합)

```ts
import { warpImage } from './index.js';

const outputPath = await warpImage('/path/to/photo.jpg');
// -> '/path/to/photo_warp.jpg' 가 생성되고, 그 경로가 반환됩니다.
```

### API

```ts
function warpImage(inputPath: string): Promise<string>
```

| 항목 | 설명 |
| --- | --- |
| 인자 | `inputPath` — 입력 이미지 파일 경로 (문자열 하나) |
| 동작 | 이미지 디코딩 → 문서 영역 검출 → 원근 변환(반듯하게 펴기) → 파일로 저장 |
| 저장 위치 | 입력 이미지와 같은 폴더에 `원본이름_warp.확장자`로 저장 (예: `example.jpg` → `example_warp.jpg`) |
| 반환값 | 저장된 결과 이미지의 경로(`string`) |
| 실패 시 | 문서 영역을 찾지 못하거나 변환에 실패하면 원본 이미지를 그대로 저장 (throw하지 않고 `console.warn`으로 경고) |

호출 시 콘솔에 아래 두 줄의 처리 시간이 함께 출력됩니다 (성능 비교/디버깅용, 추후 삭제 예정).
```text
순수 연산 시간 (엣지 검출 + 원근 변환): 000.0ms
처리 시간 (연산 + 출력 저장, 입력 로드 제외): 000.0ms
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
│   ├── scanner.ts    # 문서 외곽선 검출 (Canny Edge, PolyDP)
│   ├── warping.ts    # 검출된 외곽선 기준 원근 변환
│   └── cvReady.ts    # OpenCV.js(WASM) 초기화 및 캐싱
├── tsconfig.json     # TypeScript 컴파일러 설정
└── package.json      # 의존성 및 스크립트 설정
```

내부 동작(검출 알고리즘 세부 로직, 메모리 관리 등)을 수정해야 한다면 `scanner.ts`(검출)와 `warping.ts`(변환)를 참고하세요. 두 함수 모두 `cv.Mat`을 입출력으로 사용하므로 OpenCV.js WASM 메모리 해제 규칙을 따릅니다.

## 성능 관련 참고 사항

- **`scanner.ts` 검출 단계 다운스케일**: 원본 해상도 그대로 Canny/findContours를 돌리면 느리기 때문에, 이미지의 긴 변이 `DETECT_MAX_DIM`(2000px)을 넘으면 축소본에서 검출한 뒤 좌표만 원본 스케일로 환산합니다. 이 값을 더 낮추면 (예: 1600 이하) 배경의 작은 사각형을 문서로 오검출하는 사례가 확인되어, 2000을 하한으로 유지하고 있습니다.
- **흑백 변환 후 리사이즈**: 컬러(4채널) 상태에서 리사이즈하는 것보다 흑백(1채널) 변환 후 리사이즈하는 쪽이 실측상 약 2배 빠릅니다.
- **EXIF 방향 처리**: 휴대폰/카메라로 찍은 사진은 EXIF `Orientation` 태그로 회전 정보가 별도로 저장되는 경우가 많습니다. `index.ts`에서 `sharp(...).rotate()`를 호출해 이 태그를 반영한 뒤 픽셀을 읽으므로, 회전된 채로 저장된 원본도 화면에 보이는 방향 그대로 처리됩니다.
- **잘못된 촬영(재촬영 유도) 검출**: 검출된 4각형이 전체 이미지 면적의 `MIN_AREA_RATIO`(5%) 미만이면 검출 실패로 처리합니다. 문서 테두리 일부가 사진 프레임 밖으로 잘려 나가면 문서 안의 작은 표/칸 하나가 "우연히 프레임 안에서 닫힌 가장 큰 4각형"으로 오검출되는 경우가 있는데, 이를 걸러내기 위한 하한선입니다. 이 경우에도 `warpImage()`는 throw하지 않고 원본 이미지를 그대로 저장합니다.
- **`warpDocument()`의 실패 처리**: 이전에는 원근 변환 실패 시 `null`을 반환해 호출부에서 별도로 null 체크를 해야 했지만, 지금은 실패 시에도 `srcMat`의 복사본(원본 이미지)을 반환하도록 바뀌어 `Promise<cv.Mat>`을 반환합니다 (더 이상 `null`을 반환하지 않음). `warpImage()`에서도 검출/변환 과정 전체를 try/catch로 감싸 예외가 발생해도 throw하지 않고 원본 이미지를 그대로 저장하도록 처리합니다.