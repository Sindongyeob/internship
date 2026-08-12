import cvModule from '@techstark/opencv-js';

let readyPromise: Promise<typeof cvModule> | null = null;

/**
 * @techstark/opencv-js는 Node 환경에서 default export가 곧바로 준비된 cv 객체가 아니라
 * WASM 런타임 로딩이 끝나야 완료되는 Promise(또는 onRuntimeInitialized 콜백)로 내려온다.
 * 이 함수는 그 초기화를 한 번만 수행하고, 이후로는 캐시된 결과를 재사용한다.
 */
export function ensureCv(): Promise<typeof cvModule> {
    if (!readyPromise) {
        const mod = cvModule as any;

        if (mod instanceof Promise) {
            readyPromise = mod;
        } else if (mod.Mat) {
            readyPromise = Promise.resolve(mod);
        } else {
            readyPromise = new Promise((resolve) => {
                mod.onRuntimeInitialized = () => resolve(mod);
            });
        }
    }
    return readyPromise;
}
