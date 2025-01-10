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
                const handleServiceStop_result = await this.handleServiceStop(userId);

                if(!handleServiceStop_result) {
                    logger.warn(`[ AudioFileManager:handleProcessingComplete ] Error completing process`);
                } else {
                    logger.error('++++++++++++++++++++++++++++++++2++++++++++++++++++++');
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

    //  생성된 wav 통화 파일에 대한 데이터 처리가 더 없을 경우
    //  할당되어 있는 스트림 채널 할당 취소 요청
    async EmoServiceStopRQ (userinfo_userId) {
        // getErkApiMsg 함수로 ErkApiMsg 상태 검증
        const { ErkApiMsg, ch, ch2, ErkQueueInfo, ErkQueueInfo2 } = getErkApiMsg();
        logger.debug(`[ audioServices.js:EmoServiceStopRQ ] Current ErkApiMsg status: ${ErkApiMsg  ? 'defined' : 'undefined'}`);
        logger.debug(`[ audioServices.js:EmoServiceStopRQ ] userinfo_userId : ${userinfo_userId}`);

        try {
            logger.warn(`[ audioServices.js:EmoServiceStopRQ ] Stopping service for user: ${userinfo_userId}`);

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    logger.warn(`[ audioServices.js:EmoServiceStopRQ ] Channel response timeout`);
                    resolve(null);
                }, 5000);
            
                const queries = [
                    {
                        userinfo_userId: userinfo_userId,
                        queueInfo: ErkQueueInfo,
                        recvQueueNameField: 'erkengineInfo_return_recvQueueName',
                        sendQueueNameField: 'erkengineInfo_return_sendQueueName',
                    },
                    {
                        userinfo_userId: userinfo_userId - 10,
                        queueInfo: ErkQueueInfo2,
                        recvQueueNameField: 'erkengineInfo_returnCustomer_recvQueueName',
                        sendQueueNameField: 'erkengineInfo_returnCustomer_sendQueueName',
                    },
                ];
            
                let promises = queries.map((queryInfo) => {
                    return new Promise((resolveQuery, rejectQuery) => {
                        connection1.query(
                            `SELECT
                                session_id,
                                JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.org_id')) as user_orgid,
                                JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.userinfo_uuid')) as user_uuid,
                                JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.cusinfo_uuid')) as user_uuid2,
                                eui.*
                            FROM sessions s
                            LEFT JOIN emo_user_info eui
                                ON eui.login_id = JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.login_id'))
                            WHERE eui.userinfo_userid = ${queryInfo.userinfo_userId};`,
                            (err, results) => {
                                if (err) {
                                    logger.error(`[ audioServices.js:EmoServiceStopRQ ] ${err}`);
                                    rejectQuery(err);
                                    return;
                                }
            
                                if (results.length > 0) {
                                    let ErkMsgHead = ErkApiMsg.create({
                                        MsgType: 23,
                                        TransactionId: queryInfo.userinfo_userId === userinfo_userId ? results[0].user_uuid : results[0].user_uuid2,
                                        QueueInfo: queryInfo.queueInfo,
                                        OrgId: results[0].user_orgid,
                                        UserId: queryInfo.userinfo_userId,
                                    });
            
                                    let EmoServiceStopMsg = ErkApiMsg.create({
                                        EmoServiceStopRQ: {
                                            ErkMsgHead: ErkMsgHead,
                                            EmoRecogType: 1,
                                            MsgTime: DateUtils.getCurrentTimestamp(),
                                            ServiceType: results[0].userinfo_serviceType,
                                            PhysioEngine_ReceiveQueueName: "",
                                            PhysioEngine_SendQueueName: "",
                                            SpeechEngine_ReceiveQueueName: `${results[0][queryInfo.recvQueueNameField]}`,
                                            SpeechEngine_SendQueueName: `${results[0][queryInfo.sendQueueNameField]}`,
                                            FaceEngine_ReceiveQueueName: "",
                                            FaceEngine_SendQueueName: "",
                                            KnowledgeEngine_ReceiveQueueName: "",
                                            KnowledgeEngine_SendQueueName: "",
                                        },
                                    });
            
                                    let EmoServiceStopMsg_buf = ErkApiMsg.encode(EmoServiceStopMsg).finish();
                                    logger.info(`[ audioServices.js:EmoServiceStopRQ ] 생성된 EmoServiceStopRQ 메세지\n${JSON.stringify(EmoServiceStopMsg_buf, null, 4)}`);
            
                                    let emoSerStop_send_rq = `UPDATE emo_user_info
                                    SET erkEmoSrvcStop_send_dt = NOW(3)
                                    WHERE userinfo_userId = ${queryInfo.userinfo_userId};`;
            
                                    connection1.query(emoSerStop_send_rq, (err, updateResults) => {
                                        if (err) {
                                            logger.error(`[ audioServices.js:EmoServiceStopRQ ] ${err}`);
                                            rejectQuery(err);
                                            return;
                                        }
            
                                        logger.info(`[ audioServices.js:EmoServiceStopRQ ] DB 업데이트 후 메세지 송신`);
                                        (queryInfo.queueInfo === ErkQueueInfo ? ch : ch2).sendToQueue("ERK_API_QUEUE", EmoServiceStopMsg_buf);
            
                                        resolveQuery('success');
                                    });
                                } else {
                                    resolveQuery(`User not found`);
                                }
                            }
                        );
                    });
                });
            
                Promise.all(promises)
                    .then(resolve)
                    .catch(reject);
            });            
        } catch (err) {
            logger.error(`[ audioServices.js:EmoServiceStopRQ ] ${err}`);
            
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