'use strict'

const logger = require('../logs/logger');
const fsp = require('fs').promises;

const AudioProcessingManager = require(`../managers/AudioProcessingManager`);

//  파일이 필요한 크기에 도달할 때까지 대기
async function waitForRequiredSize(filePath, requiredSize, timeout = 5000) {
    const audioProcessingManager = new AudioProcessingManager();
    const startTime = Date.now();

    // 현재 설정된 타임아웃 가져오기
    const currentTimeout = audioProcessingManager.timeoutConfig.waitForSize;
    let retryCount = 0;

    return new Promise(async (resolve, reject) => {
        const checkSize = async () => {
            try {
                const stats = await fsp.stat(filePath);
                const processingTime = Date.now() - startTime;

                if (stats.size >= requiredSize) {
                    // 성공적인 처리 시 메트릭 업데이트
                    audioProcessingManager.metrics.totalProcessed++;
                    audioProcessingManager.metrics.avgProcessingTime = 
                        (audioProcessingManager.metrics.avgProcessingTime * (audioProcessingManager.metrics.totalProcessed - 1) + processingTime) 
                        / audioProcessingManager.metrics.totalProcessed;

                    // 타임아웃 동적 조정
                    await audioProcessingManager.adjustTimeouts();
                    
                    logger.info(`[ app.js:waitForRequiredSize ] Required size reached in ${processingTime}ms`);
                    resolve();
                } else if (processingTime > currentTimeout) {
                    // 타임아웃 발생 시 재시도 로직
                    if (retryCount < audioProcessingManager.timeoutConfig.maxRetries) {
                        retryCount++;
                        logger.warn(`[ app.js:waitForRequiredSize ] Timeout reached, attempting retry ${retryCount}/${audioProcessingManager.timeoutConfig.maxRetries}`);
                        
                        // 재시도 전 지정된 시간만큼 대기
                        await new Promise(resolve => setTimeout(resolve, audioProcessingManager.timeoutConfig.retryDelay));
                        checkSize();
                    } else {
                        const error = new Error(`[ app.js:waitForRequiredSize ] Timeout waiting for size ${requiredSize} bytes after ${retryCount} retries`);
                        logger.error(error.message);
                        reject(error);
                    }
                } else {
                    // 현재 진행 상황 로깅
                    if (processingTime % 1000 === 0) {  // 1초마다 로그
                        logger.info(`[ app.js:waitForRequiredSize ] Current size: ${stats.size}, Required: ${requiredSize}, Elapsed: ${processingTime}ms`);
                    }
                    setTimeout(checkSize, audioProcessingManager.timeoutConfig.retryDelay);
                }
            } catch (error) {
                if (error.code === 'ENOENT') {
                    // 파일이 아직 없는 경우
                    logger.warn(`[ app.js:waitForRequiredSize ] File not found, waiting...`);
                    setTimeout(checkSize, audioProcessingManager.timeoutConfig.retryDelay);
                } else {
                    reject(error);
                }
            }
        };

        // 초기 체크 시작
        checkSize();
    });
}

module.exports = { waitForRequiredSize };