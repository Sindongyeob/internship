# OpenCV Document Scanner (TypeScript)

TypeScript와 `@techstark/opencv-js`를 활용하여 이미지 내 문서(사각형)의 외곽선을 검출하고 처리하는 컴퓨터 비전 프로젝트입니다.

## 기술 스택
- **Runtime:** Node.js (v20 LTS 권장)
- **Language:** TypeScript
- **Computer Vision:** OpenCV.js (@techstark/opencv-js)
- **Runner:** tsx

## 주요 기능
- 이미지 내 4개의 꼭짓점을 가진 가장 큰 사각형(종이 또는 화면) 영역 검출
- Canny Edge Detection 및 흑백/블러 전처리를 통한 윤곽선 추출
- TypeScript 기반의 엄격한 타입 검사 및 객체 지향적 설계

## 시작하기

### 1. 패키지 설치
프로젝트 클론 후 의존성 패키지를 설치합니다.
```bash
npm install
```

### 2. 실행 명령어

**개발 모드 (Hot Reload 지원)**
코드 변경 사항을 즉시 반영하여 실행합니다.
```bash
npm run dev
```

**프로덕션 빌드**
TypeScript 코드를 JavaScript로 컴파일하여 `dist` 폴더에 생성합니다.
```bash
npm run build
```

**빌드 파일 실행**
컴파일된 JavaScript 파일을 실행합니다.
```bash
npm start
```

## 프로젝트 구조
```text
internship/
├── src/
│   ├── index.ts      # 애플리케이션 진입점 및 OpenCV 로드 검증
│   └── scanner.ts    # 문서 외곽선 검출(Canny Edge, PolyDP) 핵심 로직
├── .vscode/          # VS Code 작업 공간 설정
├── tsconfig.json     # TypeScript 컴파일러 설정
└── package.json      # 프로젝트 의존성 및 스크립트 설정
```