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
| 동작 | 문서 영역 검출 → 원근 변환(반듯하게 펴기) → 파일로 저장 |
| 저장 위치 | 입력 이미지와 같은 폴더에 `원본이름_warp.확장자`로 저장 (예: `example.jpg` → `example_warp.jpg`) |
| 반환값 | 저장된 결과 이미지의 경로(`string`) |
| 실패 시 | 문서 영역을 찾지 못하거나 변환에 실패하면 `Error`를 throw |

### 의존성

```bash
npm install @techstark/opencv-js jimp
```

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
│   ├── index.ts      # 통합 진입점 — warpImage() 제공 + 단독 실행용 CLI
│   ├── scanner.ts    # 문서 외곽선 검출 (Canny Edge, PolyDP)
│   ├── warping.ts    # 검출된 외곽선 기준 원근 변환
│   └── cvReady.ts    # OpenCV.js(WASM) 초기화 및 캐싱
├── tsconfig.json     # TypeScript 컴파일러 설정
└── package.json      # 의존성 및 스크립트 설정
```

내부 동작(검출 알고리즘 세부 로직, 메모리 관리 등)을 수정해야 한다면 `scanner.ts`(검출)와 `warping.ts`(변환)를 참고하세요. 두 함수 모두 `cv.Mat`을 입출력으로 사용하므로 OpenCV.js WASM 메모리 해제 규칙을 따릅니다.
