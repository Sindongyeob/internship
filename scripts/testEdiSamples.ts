import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pdf } from 'pdf-to-img';
import { warpImage } from '../src/index.js';

const SAMPLES_DIR = path.resolve('samples/edi');
const RESULTS_DIR = path.resolve('results/edi');
const TMP_DIR = path.resolve('results/.tmp');
const LOG_PATH = path.resolve('results/edi-run.log');

// warpImage()가 실패 시 console.error(JSON.stringify(...))로 남기는 로그는 base64 이미지를
// 포함해서 한 줄이 매우 길다. 70페이지를 다 돌리면 터미널이 그 로그로 뒤덮여 읽을 수 없으므로,
// console.error를 가로채 "전체 내용은 파일로, 터미널에는 요약만" 남기도록 한다.
function setupTeeLogging(): { restore: () => void; close: () => Promise<void> } {
    const logStream = createWriteStream(LOG_PATH, { flags: 'w' });
    const originalConsoleError = console.error.bind(console);

    console.error = (...args: unknown[]) => {
        const line = args
            .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' ');
        logStream.write(line + '\n');

        const preview = line.length > 200 ? `${line.slice(0, 200)}... (전체 내용은 ${LOG_PATH} 참고)` : line;
        originalConsoleError(preview);
    };

    return {
        restore: () => { console.error = originalConsoleError; },
        close: () => new Promise((resolve) => logStream.end(resolve)),
    };
}

// samples/edi의 모든 PDF를 전체 페이지 이미지로 렌더링해 warpImage()에 돌려보고,
// 결과를 results/edi/에 저장한다. 실패 로그(JSON, base64 포함)는 results/edi-run.log에 남는다.
async function main() {
    await fs.mkdir(RESULTS_DIR, { recursive: true });
    await fs.mkdir(TMP_DIR, { recursive: true });

    const { restore, close } = setupTeeLogging();

    try {
        const files = (await fs.readdir(SAMPLES_DIR)).filter((f) => f.toLowerCase().endsWith('.pdf'));

        const methodCounts: Record<'perspective' | 'deskew' | 'original', number> = {
            perspective: 0,
            deskew: 0,
            original: 0,
        };
        let totalPages = 0;

        for (const file of files) {
            const pdfPath = path.join(SAMPLES_DIR, file);
            const name = path.parse(file).name;

            const doc = await pdf(pdfPath);
            console.log(`--- ${file} (${doc.length}페이지) ---`);

            for (let pageNum = 1; pageNum <= doc.length; pageNum++) {
                const pageBuffer = await doc.getPage(pageNum);

                // warpImage()는 파일 경로를 입력으로 받으므로, 렌더링한 PNG를 임시 파일로 저장한다.
                const tmpPngPath = path.join(TMP_DIR, `${name}_page${pageNum}.png`);
                await fs.writeFile(tmpPngPath, pageBuffer);

                try {
                    const { method, image } = await warpImage(tmpPngPath);
                    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
                    const outputPath = path.join(RESULTS_DIR, `${name}_page${pageNum}_warp.jpg`);
                    await fs.writeFile(outputPath, Buffer.from(base64Data, 'base64'));

                    console.log(`  [${pageNum}/${doc.length}] ${method}: ${path.basename(outputPath)}`);
                    methodCounts[method]++;
                    totalPages++;
                } finally {
                    await fs.rm(tmpPngPath, { force: true });
                }
            }

            await doc.destroy();
            console.log();
        }

        console.log(
            `완료: perspective ${methodCounts.perspective}개 / deskew ${methodCounts.deskew}개 / ` +
            `original ${methodCounts.original}개 (총 ${totalPages}페이지)`
        );
        console.log(`실패(original) 로그(JSON, base64 포함) 전체 내용: ${LOG_PATH}`);
    } finally {
        restore();
        await close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
