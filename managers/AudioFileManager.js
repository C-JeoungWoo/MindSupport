'use strict'
//  음성 파일의 청크 처리, GSM/PCM 변환, 메타데이터 관리를 담당하는 매니저
const DateUtils = require('../utils/dateUtils');

const logger = require('../logs/logger');

const { getErkApiMsg } = require('../utils/erkUtils');

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
        this.pendingFiles = new Map();        // 파일 처리 상태 관리
        this.callTracker = new Map();         // 통화별 rx/tx 상태 추적 추가
        // 20250117 추가
        this.processedFiles = new Set();     // 처리 완료된 파일 추적용 Set
        this.processingAttempts = new Map(); // 처리 시도 횟수 추적
        this.MAX_PROCESSING_ATTEMPTS = 3;    // 최대 처리 시도 횟수
    }

     // 파일 처리 시도 횟수 확인 및 증가 // 20250117 추가
     _incrementProcessingAttempt(filePath) {
        const attempts = this.processingAttempts.get(filePath) || 0;
        this.processingAttempts.set(filePath, attempts + 1);
        return attempts + 1;
    }   

    // 파일 처리 상태 초기화 // 20250117 추가
    initializeFileProcessing(filePath, fileType) {
        if (this.processedFiles.has(filePath)) {
            logger.warn(`File ${filePath} has already been processed`);
            return false;
        }

        this.pendingFiles.set(filePath, {
            fileTypeInfo: { fileType: fileType },
            processingStartTime: Date.now()
        });
        return true;
    }

    // 파일 처리 완료 핸들러 수정
    async handleProcessingComplete(filePath, userId) {
        try {
            const fileName = path.basename(filePath, '.wav'); //home/nb~~~ 여기서 가장 마지막 경로인 2025~~~~._tx.wav 만 가져옴
            const callId = fileName.split('_')[2]; //위의 파일에서 '_' 를 기준으로 2번째 스플릿한 데이터를 가져옴
            const fileInfo = this.pendingFiles.get(filePath);
            const callInfo = this.callTracker.get(callId);
            
            // 디버깅 로깅 추가
            // logger.error(`[ AudioFileManager:handleProcessingComplete ] fileName 반환값: ${JSON.stringify(fileName)}`);
            // logger.error(`[ AudioFileManager:handleProcessingComplete ] fileInfo 반환값: ${JSON.stringify(fileInfo)}`);
            // logger.error(`[ AudioFileManager:handleProcessingComplete ] callInfo 반환값: ${JSON.stringify(callInfo)}`);

            // 이미 처리 완료된 파일인지 확인
            if (!fileInfo || fileInfo.fileTypeInfo.fileType === 'completed') {
                logger.error(`File already processed: ${fileName}`);
                return false; // 중복 처리 시도 시 false 반환
            }   

            // 처리 시도 횟수 확인 //202517
            const attempts = this._incrementProcessingAttempt(filePath);
            if (attempts > this.MAX_PROCESSING_ATTEMPTS) {
                logger.error(`Maximum processing attempts reached for file: ${fileName}`);
                this.cleanup(filePath);
                return false;
            }

            // 파일 유효성 검사
            if (!fileName.endsWith('_rx') && !fileName.endsWith('_tx')) {
                logger.error(`Invalid filePath format: ${fileName}. Must end with '_rx' or '_tx'.`);
                return false;
            }

            if (!callInfo) { 
                logger.error(`No call info found for ${callId}`);
                return false; // callInfo가 없으면 종료
            }

            // if (!callInfo.rx || !callInfo.tx) {
            //     logger.error(`[ AudioFileManager:handleProcessingComplete ] Incomplete callInfo: ${JSON.stringify(callInfo)}`);
            //     return false; // 정보가 완전하지 않으면 종료
            // }

            // if (fileName.endsWith('_rx')) {
            //     // 현재 파일 타입의 상태를 완료로 변경
            //     callInfo.rx.status = 'completed'; //20250117 수정
            // } else if (fileName.endsWith('_tx')) {
            //     // 현재 파일 타입의 상태를 완료로 변경
            //     callInfo.tx.status = 'completed'; //20250117 수정
            // }

            const fileType = fileName.endsWith('_rx') ? 'rx' : 'tx';
            callInfo[fileType].status = 'completed';
            

            // 현재 파일 타입의 상태를 완료로 변경
            if (fileInfo && fileInfo.fileTypeInfo) {
                fileInfo.fileTypeInfo.fileType = 'completed'; //20250109 수정
            }

            
            // rx와 tx 모두 완료된 경우에만 EmoServiceStop 호출
            if (callInfo.rx.status === 'completed' && callInfo.tx.status === 'completed') {
                const handleServiceStop_result = await this.handleServiceStop(userId);

                // 디버깅 로깅 추가
                logger.error(`[ AudioFileManager:handleProcessingComplete ] handleServiceStop 반환값: ${handleServiceStop_result}`);

                // rx와 tx 모두 완료 확인
                if (callInfo.rx.status === 'completed' && callInfo.tx.status === 'completed') {
                    const serviceStopResult = await this.handleServiceStop(userId);
                    
                    if (serviceStopResult === true) {
                        // 모든 처리가 완료되면 cleanup 수행
                        this.processedFiles.add(filePath);
                        this.cleanup(filePath, callId);
                        return true;
                    }
                    return false;
                }

                return true;
            }
            return true; // 부분 처리 완료
        } catch (error) {
            logger.error(`[ AudioFileManager:handleProcessingComplete ] Error completing process: ${error}`);
            return false;
        }
    }

    // EmoServiceStop 처리 중앙화
    async handleServiceStop(userId) {
        try {
            const stopResult = await this.EmoServiceStopRQ(userId);

            // 디버깅 로깅 추가
            logger.error(`[ AudioFileManager:handleServiceStop ] EmoServiceStopRQ 반환값 확인용 로그 : ${JSON.stringify(stopResult)}`); // success or failed

            if (stopResult !== 'success') {
                return false;
            }

            // 성공시 true 반환
            return true;

        } catch (error) {
            logger.error(`[ AudioFileManager.js:handleServiceStop ] Error stopping service: ${error}`);
            throw error;  // 상위 로직에서 처리하도록 전달   
        }
    }

    //  생성된 wav 통화 파일에 대한 데이터 처리가 더 없을 경우
    //  할당되어 있는 스트림 채널 할당 취소 요청
    async EmoServiceStopRQ(userinfo_userId) {
        // getErkApiMsg 함수로 ErkApiMsg 상태 검증
        const { ErkApiMsg, ch, ch2, ErkQueueInfo, ErkQueueInfo2 } = getErkApiMsg();
    
        try {
            let stop_userinfo_userId = userinfo_userId > 4 ? userinfo_userId - 3 : userinfo_userId;
    
            let test_qry = `
            SELECT
                session_id,
                JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.org_id')) as user_orgid,
                JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.userinfo_uuid')) as user_uuid,
                JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.cusinfo_uuid')) as user_uuid2,
                eui.*
            FROM sessions s
            LEFT JOIN emo_user_info eui
                ON eui.login_id = JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.login_id'))
            WHERE eui.userinfo_userid = ${stop_userinfo_userId};
            `;
    
            // 상담원 조회 Promise 처리
            const results = await new Promise((resolve, reject) => {
                connection1.query(test_qry, (err, results) => {
                    if (err) return reject(err);
                    resolve(results);
                });
            });
    
            if (results.length > 0) {
                // ErkMsgHead 생성
                let ErkMsgHead = ErkApiMsg.create({
                    MsgType: 23,
                    TransactionId: results[0].user_uuid,
                    QueueInfo: ErkQueueInfo,
                    OrgId: results[0].user_orgid,
                    UserId: results[0].userinfo_userId,
                });
    
                let EmoServiceStopMsg = ErkApiMsg.create({
                    EmoServiceStopRQ: {
                        ErkMsgHead: ErkMsgHead,
                        EmoRecogType: 1,
                        MsgTime: DateUtils.getCurrentTimestamp(),
                        ServiceType: results[0].userinfo_serviceType,
                        SpeechEngine_ReceiveQueueName: `${results[0].erkengineInfo_return_recvQueueName}`,
                        SpeechEngine_SendQueueName: `${results[0].erkengineInfo_return_sendQueueName}`,
                    },
                });
    
                let EmoServiceStopMsg_buf = ErkApiMsg.encode(EmoServiceStopMsg).finish();
    
                // 고객 데이터 조회 Promise 처리
                let cus_stop_qry = `
                SELECT * 
                FROM emo_user_info
                WHERE userinfo_userId = ${stop_userinfo_userId + 3};
                `;
    
                const cus_results = await new Promise((resolve, reject) => {
                    connection1.query(cus_stop_qry, (err, results) => {
                        if (err) return reject(err);
                        resolve(results);
                    });
                });
    
                if (cus_results.length > 0) {
                    let ErkMsgHead_cus = ErkApiMsg.create({
                        MsgType: 23,
                        TransactionId: results[0].user_uuid2,
                        QueueInfo: ErkQueueInfo2,
                        OrgId: results[0].user_orgid,
                        UserId: results[0].userinfo_userId + 3,
                    });
    
                    let EmoServiceStopMsg_cus = ErkApiMsg.create({
                        EmoServiceStopRQ: {
                            ErkMsgHead: ErkMsgHead_cus,
                            EmoRecogType: 1,
                            MsgTime: DateUtils.getCurrentTimestamp(),
                            ServiceType: cus_results[0].userinfo_serviceType,
                            SpeechEngine_ReceiveQueueName: `${cus_results[0].erkengineInfo_returnCustomer_recvQueueName}`,
                            SpeechEngine_SendQueueName: `${cus_results[0].erkengineInfo_returnCustomer_sendQueueName}`,
                        },
                    });
    
                    let EmoServiceStopMsg_buf_cus = ErkApiMsg.encode(EmoServiceStopMsg_cus).finish();
    
                    // RabbitMQ 큐로 메시지 전송
                    ch.sendToQueue("ERK_API_QUEUE", EmoServiceStopMsg_buf);
                    setTimeout(() => {
                        ch2.sendToQueue("ERK_API_QUEUE", EmoServiceStopMsg_buf_cus);
                    }, 150);
    
                    // 송신 시간 업데이트
                    let emoSerStop_send_rq = `
                    UPDATE emo_user_info
                    SET erkEmoSrvcStop_send_dt = NOW(3)
                    WHERE userinfo_userId IN(${results[0].userinfo_userId}, ${results[0].userinfo_userId + 3});
                    `;
                    await new Promise((resolve, reject) => {
                        connection1.query(emoSerStop_send_rq, (err, results) => {
                            if (err) return reject(err);
                            resolve(results);
                        });
                    });
    
                    return 'success';
                }
            } else {
                logger.warn(`[ AudioFileManager.js:EmoServiceStopRQ] 현재 접속되어 있는 상담원 없음`);
                return 'failed';
            }
        } catch (err) {
            logger.error(`[ AudioFileManager.js:EmoServiceStopRQ ] ${err}`);
            return {
                message: 'error',
                return_type: 0,
                error: err.message,
            };
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

    // 리소스 정리
    cleanup(fileKey) {
        this.pendingFiles.delete(fileKey);
        this.processedFiles.delete(fileKey);
        this.callTracker.delete(fileKey.split('_')[2]); // callId 기반 정리
    
        logger.info(`[ AudioFileManager:cleanup ] Cleaned up resources for ${fileKey}`);
    }

    // 처리 상태 조회
    getProcessingStatus(filePath) {
        return {
            isProcessed: this.processedFiles.has(filePath),
            attempts: this.processingAttempts.get(filePath) || 0,
            pendingInfo: this.pendingFiles.get(filePath),
            maxAttempts: this.MAX_PROCESSING_ATTEMPTS
        };
    }
    
}

module.exports = AudioFileManager;