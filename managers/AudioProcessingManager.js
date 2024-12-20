'use strict'
//  실시간 녹취 음성 데이터의 변환 및 감정 분석 서버 전송을 처리하는 매니저

//  오디오 청크 타이밍 관리 클래스
class AudioProcessingManager {
    constructor() {
        this.timeoutConfig = {
            waitForSize: 4000,      // 기본 4초
            processingTimeout: 5000, // 처리 타임아웃
            retryDelay: 1000,       // 재시도 간격
            maxRetries: 3           // 최대 재시도 횟수
        };
        this.metrics = {
            avgProcessingTime: 0,
            successRate: 0,
            totalProcessed: 0
        };
    }

    async adjustTimeouts() {
        // 처리 시간 메트릭을 기반으로 타임아웃 동적 조정
        const avgTime = this.metrics.avgProcessingTime;
        if (avgTime > this.timeoutConfig.waitForSize * 0.8) {
            this.timeoutConfig.waitForSize = avgTime * 1.5;
        }
    }
}

module.exports = AudioProcessingManager;