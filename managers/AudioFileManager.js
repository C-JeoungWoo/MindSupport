'use strict'
//  음성 파일의 청크 처리, GSM/PCM 변환, 메타데이터 관리를 담당하는 매니저
const DateUtils = require('../utils/dateUtils');

const logger = require('../logs/logger');
const audioServices  = require('../services/audioServices');

//  DB 연결( 추후 모듈화로 코드 최적화 필요 )
const mysql = require('../db/maria')();
const mysql2 = require('../db/acrV4')();

const connection1 = mysql.pool();
const connection2 = mysql2.pool();

mysql.pool_check(connection1);
mysql2.pool_check(connection2);

const path = require('path');

//  파일 상태 관리 클래스
class AudioFileManager {
    //  구조체 선언
    constructor() {
        this.pendingFiles = new Map();   // 파일 처리 상태 관리
        this.callTracker = new Map();      // 통화별 rx/tx 상태 추적 추가
    }

    // 파일 처리 완료 핸들러 수정
    async handleProcessingComplete(filePath, userId) {
        try {
            const fileName = path.basename(filePath, '.wav'); //home/nb~~~ 여기서 가장 마지막 경로인 2025~~~~._tx.wav 만 가져옴
            const callId = fileName.split('_')[2]; //위의 파일에서 '_' 를 기준으로 2번째 스플릿한 데이터를 가져옴

            const fileInfo = this.pendingFiles.get(filePath); // 20250109 일단 주석 처리
            const callInfo = this.callTracker.get(callId);

            if (!fileName.endsWith('_rx') && !fileName.endsWith('_tx')) {
                throw new Error(`Invalid filePath format: ${fileName}. Must end with '_rx' or '_tx'.`);
            }

            //callId 는 fileName에서 상담사의 번호를 추출하여 저장한 함수 EX) 2501, 2502, ...
            if (!callId) { throw new Error(`No call info found for ${callId}`); }

            // 현재 파일 타입의 상태를 완료로 변경
            if (fileInfo && fileInfo.fileTypeInfo) {
                fileInfo.fileTypeInfo.fileType = 'completed'; //20250109 수정
            }

            // 현재 파일 타입의 상태를 완료로 변경
            if (callInfo && callInfo.rx && callInfo.tx) {
                callInfo.rx.status = 'completed'; //20250109 수정
                callInfo.tx.status = 'completed'; //20250109 수정
            }
            
            // rx와 tx 모두 완료된 경우에만 EmoServiceStop 호출
            if (callInfo.rx.status === 'completed' && callInfo.tx.status === 'completed') {
                logger.error('1');
                const handleServiceStop_result = await this.handleServiceStop(userId);
                logger.error('2');
                this.callTracker.delete(callId);  // 통화 추적 정보 삭제

                if(!handleServiceStop_result) {
                    logger.warn(`[ AudioFileManager:handleProcessingComplete ] Error completing process`);
                } else {
                    return true;
                }
            }
            this.markFileComplete(filePath);

        } catch (error) {
            logger.error(`[ AudioFileManager:handleProcessingComplete ] Error completing process: ${error}`);
            return false;
        }
    }

    // 5. 파일 처리 완료 표시
    markFileComplete(filePath) {
        if (this.pendingFiles.has(filePath)) {
            const fileInfo = this.pendingFiles.get(filePath);

            logger.info(`[ AudioFileManager:markFileComplete ] Completed: ${fileInfo}`);

            this.pendingFiles.delete(filePath);
        }
    }

    // EmoServiceStop 처리 중앙화
    async handleServiceStop(userId) {
        logger.error('99999999')
        try {
            const stopResult = await audioServices.EmoServiceStopRQ(userId);
            
            if (stopResult === 'success') {
                logger.info(`[ AudioFileManager:handleServiceStop ] Service stopped successfully for user ${userId}`);

                return true;
            } else {
                logger.error(`[ AudioFileManager:handleServiceStop ] Failed to stop service: ${stopResult}`);

                return false;
            }
        } catch (error) {
            logger.error(`[ AudioFileManager:handleServiceStop ] Error stopping service: ${error}`);
            throw error;
        }
    }


}

module.exports = AudioFileManager;