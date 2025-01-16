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
        this.pendingFiles = new Map();   // 파일 처리 상태 관리
        this.callTracker = new Map();      // 통화별 rx/tx 상태 추적 추가
    }

    // 파일 처리 완료 핸들러 수정
    async handleProcessingComplete(filePath, userId) {
        try {
            const fileName = path.basename(filePath, '.wav'); //home/nb~~~ 여기서 가장 마지막 경로인 2025~~~~._tx.wav 만 가져옴
            const callId = fileName.split('_')[2]; //위의 파일에서 '_' 를 기준으로 2번째 스플릿한 데이터를 가져옴
            const fileInfo = this.pendingFiles.get(filePath);
            const callInfo = this.callTracker.get(callId);

            // 디버깅 로깅 추가
            logger.error(`[ AudioFileManager:handleProcessingComplete ] \ncallId: ${callId}\n fileInfo: ${JSON.stringify(fileInfo)}\n callInfo: ${JSON.stringify(callInfo)}`);

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
                const handleServiceStop_result = await this.handleServiceStop(userId);

                // 디버깅 로깅 추가
                logger.error(`[ AudioFileManager:handleProcessingComplete ] handleServiceStop 반환값: ${handleServiceStop_result}`);

                if(handleServiceStop_result !== true) { // 250110 true 값 받는거 수정
                    logger.error(`[ AudioFileManager:handleProcessingComplete ] Error completing process.......`);
                    return false;
                } else {
                    this.callTracker.delete(callId);  // 통화 추적 정보 삭제
                    return true;
                }
            }
            this.markFileComplete(filePath);
        } catch (error) {
            logger.error(`[ AudioFileManager:handleProcessingComplete ] Error completing process: ${error}`);
            return false;
        }
    }

    // EmoServiceStop 처리 중앙화
    async handleServiceStop(userId) {
        try {
            const stopResult = await this.EmoServiceStopRQ(userId);

            if (!stopResult) {
                logger.warn(`[ AudioFileManager:handleServiceStop ] Received undefined result from EmoServiceStopRQ`);
                return false;
            }

        } catch (error) {
            logger.error(`[ AudioFileManager.js:handleServiceStop ] Error stopping service: ${error}`);
            throw error;  // 상위 로직에서 처리하도록 전달   
        }
    }

    //  생성된 wav 통화 파일에 대한 데이터 처리가 더 없을 경우
    //  할당되어 있는 스트림 채널 할당 취소 요청
    async EmoServiceStopRQ (userinfo_userId) {
        // getErkApiMsg 함수로 ErkApiMsg 상태 검증
        const { ErkApiMsg, ch, ch2, ErkQueueInfo, ErkQueueInfo2 } = getErkApiMsg();
        logger.debug(`[ audioServices.js:EmoServiceStopRQ ] Current ErkApiMsg status: ${ErkApiMsg  ? 'defined' : 'undefined'}`);
        logger.debug(`[ audioServices.js:EmoServiceStopRQ ] userinfo_userId : ${userinfo_userId}`);

        try {
            if( userinfo_userId > 10) { return 'success' }
            let stop_userinfo_userId = userinfo_userId >= 10 ? userinfo_userId-10 : userinfo_userId;

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

            connection1.query(test_qry, (err, results) => {
                if(err) {
                    logger.error(`[ AudioFileManager.js:EmoServiceStopRQ ] ${err}`);
                    throw err;
                }
                logger.info(`[ AudioFileManager.js:EmoServiceStopRQ ] 상담원 현재 상태 조회 결과 ${results.length}건`);

                if (results.length > 0) {
                    //  상담원
                    let ErkMsgHead = ErkApiMsg.create({
                        MsgType: 23,
                        TransactionId: results[0].user_uuid,
                        QueueInfo: ErkQueueInfo,
                        OrgId: results[0].user_orgid,
                        UserId: results[0].userinfo_userId
                    });

                    let EmoServiceStopMsg = ErkApiMsg.create({
                        EmoServiceStopRQ: {
                            ErkMsgHead: ErkMsgHead,
                            EmoRecogType: 1,    // 개인감성 or 사회감성
                            MsgTime: DateUtils.getCurrentTimestamp(), // 년월일시분초밀리초
                            ServiceType: results[0].userinfo_serviceType,
                            PhysioEngine_ReceiveQueueName: "",
                            PhysioEngine_SendQueueName: "",
                            SpeechEngine_ReceiveQueueName: `${results[0].erkengineInfo_return_recvQueueName}`,
                            SpeechEngine_SendQueueName: `${results[0].erkengineInfo_return_sendQueueName}`,
                            FaceEngine_ReceiveQueueName: "",
                            FaceEngine_SendQueueName: "",
                            KnowledgeEngine_ReceiveQueueName: "",
                            KnowledgeEngine_SendQueueName: "",
                        }
                    });

                    //  고객 정보도 조회 250113
                    let cus_stop_qry = `
                    SELECT * 
                    FROM emo_user_info
                    WHERE userinfo_userId = ${stop_userinfo_userId + 3};`;

                    connection1.query(cus_stop_qry, (err, cus_results) => {
                        if(err) {
                            logger.error(`[ AudioFileManager.js:EmoServiceStopRQ ] ${err}`);
                            throw err;
                        }
                        logger.info(`[ AudioFileManager.js:EmoServiceStopRQ ] 매핑된 고객 데이터 조회 결과 ${cus_results.length}건`);

                        //  고객
                        let ErkMsgHead_cus = ErkApiMsg.create({
                            MsgType: 23,
                            TransactionId: results[0].user_uuid2,
                            QueueInfo: ErkQueueInfo2,
                            OrgId: results[0].user_orgid,
                            UserId: results[0].userinfo_userId + 3
                        });

                        let EmoServiceStopMsg_cus = ErkApiMsg.create({
                            EmoServiceStopRQ: {
                                ErkMsgHead: ErkMsgHead_cus,
                                EmoRecogType: 1,    // 개인감성 or 사회감성
                                MsgTime: DateUtils.getCurrentTimestamp(), // 년월일시분초밀리초
                                ServiceType: cus_results[0].userinfo_serviceType,
                                PhysioEngine_ReceiveQueueName: "",
                                PhysioEngine_SendQueueName: "",
                                SpeechEngine_ReceiveQueueName: `${cus_results[0].erkengineInfo_returnCustomer_recvQueueName}`,
                                SpeechEngine_SendQueueName: `${cus_results[0].erkengineInfo_returnCustomer_sendQueueName}`,
                                FaceEngine_ReceiveQueueName: "",
                                FaceEngine_SendQueueName: "",
                                KnowledgeEngine_ReceiveQueueName: "",
                                KnowledgeEngine_SendQueueName: "",
                            }
                        });
                        //  EmoServiceStop 메세지 인코딩 251113
                        let EmoServiceStopMsg_buf = ErkApiMsg.encode(EmoServiceStopMsg).finish();
                        let EmoServiceStopMsg_buf_cus = ErkApiMsg.encode(EmoServiceStopMsg_cus).finish();

                        // 150ms 대기 후 두 번째 큐에 메세지 송신
                        ch.sendToQueue("ERK_API_QUEUE", EmoServiceStopMsg_buf);
                        setTimeout(() => {
                            ch2.sendToQueue("ERK_API_QUEUE", EmoServiceStopMsg_buf_cus);
                        }, 150);

                        logger.info(`[ AudioFileManager.js:emoSerStop_send_rq ] 업데이트 후 메세지 송신\n${JSON.stringify(EmoServiceStopMsg, null, 4)}`);
                        logger.info(`[ AudioFileManager.js:emoSerStop_send_rq ] 업데이트 후 메세지 송신\n${JSON.stringify(EmoServiceStopMsg_cus, null, 4)}`);

                        let emoSerStop_send_rq = `UPDATE emo_user_info
                        SET erkEmoSrvcStop_send_dt = NOW(3)
                        WHERE userinfo_userId IN(${results[0].userinfo_userId}, ${results[0].userinfo_userId + 3});`;
                        connection1.query(emoSerStop_send_rq, (err, results) => {
                            if (err) {
                                logger.error(`[ AudioFileManager.js:emoSerStop_send_rq ] ${err}`);
                                return null;
                            }
                            logger.info(`[ AudioFileManager.js:emoSerStop_send_rq ] EmoServieStop 송신 시간 업데이트 성공`);
                        });

                        return 'success';
                    });
                } else {
                    logger.warn(`[ AudioFileManager.js:EmoServiceStopRQ] 현재 접속되어 있는 상담원 없음`);

                    return 'failed';
                }
            });
        } catch (err) {
            logger.error(`[ AudioFileManager.js:EmoServiceStopRQ ] ${err}`);
            
            return {
                message: 'error',
                return_type: 0,
                error: err.message
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
    
}

module.exports = AudioFileManager;