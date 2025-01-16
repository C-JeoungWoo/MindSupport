'use strict'
//  RabbitMQ 채널 관리 및 stream queue 정보 조회/포맷팅을 담당하는 매니저

//  DB 연결( 추후 모듈화로 코드 최적화 필요 )
const mysql = require('../db/maria')();
const mysql2 = require('../db/acrV4')();

const connection1 = mysql.pool();
const connection2 = mysql2.pool();

mysql.pool_check(connection1);
mysql2.pool_check(connection2);

const { setErkApiMsg, getErkApiMsg } = require('../utils/erkUtils');

const logger = require('../logs/logger');

//  Queue 관리 클래스
class QueueManager {
    constructor(userId, fileType, channels) {
        // 채널 정보
        this.ch = channels.ch;    // 상담원 채널
        this.ch2 = channels.ch2;    // 고객 채널

        //  stream queue 관련 정보
        this.userId = userId;       // userinfo_userId
        this.fileType = fileType;   // rx 또는 tx
    }

    // 기본 채널 가져오기 (상담원/고객)
    getBaseChannel(isCustomer = false) { return isCustomer ? this.ch2 : this.ch; }

    // 메시지 전송
    async sendToQueue(queue, message, isCustomer = false) {
        try {
            const channel = this.getBaseChannel(isCustomer);
            await channel.sendToQueue(queue, message, { persistent: true });
            logger.info(`[ QueueManager:sendToQueue ] Message sent via ${isCustomer ? 'customer' : 'counselor'} channel to queue: ${queue}`);
        } catch (error) {
            logger.error(`[ QueueManager:sendToQueue ] Error:`, error);
            throw error;
        }
    }

    //  StreamQueue 정보 조회
    async fetchQueueInfo(currentErkApiMsg) {
        try {
            // 상담원과 고객의 queue 정보 조회
            const [counselorData, customerData] = await Promise.all([
                // 상담원 queue 정보 조회
                new Promise((resolve, reject) => {
                    const QueueInfoQuery = `
                        SELECT * FROM emo_user_info eui 
                        INNER JOIN emo_provider_info epi ON eui.org_name = epi.org_name 
                        WHERE eui.userinfo_userId = ?`;
                    connection1.query(QueueInfoQuery, [this.userId], (err, results) => {
                        if (err) {
                            logger.error(`[ QueueManager:fetchQueueInfo ] Counselor query error: ${err}`);
                            reject(err);
                        }
                        resolve(results[0]);
                    });
                }),
                // 고객 queue 정보 조회
                new Promise((resolve, reject) => {
                    const QueueInfoQuery = `
                        SELECT * FROM emo_user_info eui 
                        INNER JOIN emo_provider_info epi ON eui.org_name = epi.org_name 
                        WHERE eui.userinfo_userId = ?`;
                    connection1.query(QueueInfoQuery, [this.userId + 3], (err, results) => {
                        if (err) {
                            logger.error(`[ QueueManager:fetchQueueInfo ] Customer query error: ${err}`);
                            reject(err);
                        }
                        resolve(results[0]);
                    });
                })
            ]);
    
            // 로깅 추가
            logger.info('[ QueueManager:fetchQueueInfo ] Queue data retrieved:', {
                counselorData: counselorData ? 'exists' : 'null',
                customerData: customerData ? 'exists' : 'null'
            });
    
            // 두 데이터를 배열로 반환
            return [counselorData, customerData];
    
        } catch (error) {
            logger.error(`[ QueueManager:fetchQueueInfo ] Error:`, {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    // 큐 정보 포맷팅
    formatQueueInfo(data) {
        if (!data) { throw new Error('No queue data provided');  }

        const { ErkApiMsg, ch, ch2 } = getErkApiMsg();

        const {
            erkengineInfo_return_sendQueueName,
            erkengineInfo_return_recvQueueName,
            erkengineInfo_returnCustomer_recvQueueName,
            erkengineInfo_returnCustomer_sendQueueName,
            org_id,
            userinfo_userId
        } = data;

        //  전달받은 userinfo_userId 로 최근 로그인 이력을 통한 uuid, uuid2 조회
        const select_uuid_qry = `SELECT uuid, uuid2
        FROM emo_loginout_info
        WHERE userinfo_userid = ?
        AND loginout_type = 'I'
        ORDER BY loginout_dt DESC
        LIMIT 1`;

        connection1.query(select_uuid_qry, [userinfo_userId], (error, results) => {
                if (error) {
                    logger.error(`[ QueueManager:formatQueueInfo ] UUID query error: ${error}`);
                    return;
                }
                
                const { uuid, uuid2 } = results[0];  // uuid: 상담원, uuid2: 고객
                logger.info(`[ QueueManager:formatQueueInfo ] Found UUIDs - counselor: ${uuid}, customer: ${uuid2}`);

                // rx/tx에 따른 큐 선택
                const selectedQueue = this.fileType === 'rx' 
                ? {
                    toQueue: erkengineInfo_return_recvQueueName,
                    fromQueue: erkengineInfo_return_sendQueueName,
                    TransactionId: uuid,
                    userId: userinfo_userId,
                    type: 'rx'
                } 
                : {
                    toQueue: erkengineInfo_returnCustomer_recvQueueName,
                    fromQueue: erkengineInfo_returnCustomer_sendQueueName,
                    TransactionId: uuid2,
                    userId: userinfo_userId + 3,
                    type: 'tx'
                };

                // 로깅
                this.logQueueInfo(selectedQueue);

                // ErkApiMsg로 직접 생성
                const queueInfo = ErkApiMsg.create({
                    ToQueueName: selectedQueue.toQueue,
                    FromQueueName: selectedQueue.fromQueue
                });

                // 청크 데이터 관련 설정 추가
                const chunkConfig = {
                    ErkMsgDataHead: ErkApiMsg.create({
                        MsgType: 27,
                        TransactionId: selectedQueue.TransactionId,
                        QueueInfo: queueInfo,
                        OrgId: org_id,
                        UserId: selectedQueue.userId,
                    })
                    // 추후 추가적인 설정이 생긴다면 추가
                    // AudioRecognitionConfig: ErkApiMsg.create({
                    //     recognitionType: this.fileType === 'rx' ? 1 : 2,
                    //     sampleRate: 16000,
                    //     channels: 1,
                    //     encoding: 1
                    // })
                };
        
                return {
                    selectedQueue,
                    queueInfo,
                    header: chunkConfig.ErkMsgDataHead
                };
            }
        );
    }

    // 큐 정보 로깅
    logQueueInfo(selectedQueue) {
        logger.info(`[ QueueManager:logQueueInfo ] ${this.fileType} 파일 처리 - 수신 큐: ${selectedQueue.toQueue}, 송신 큐: ${selectedQueue.fromQueue}`);
    }
}

// module.exports = {
//     QueueManager,
//     setErkApiMsg  
// }
module.exports = QueueManager;