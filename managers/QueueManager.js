'use strict'
//  RabbitMQ 채널 관리 및 stream queue 정보 조회/포맷팅을 담당하는 매니저

//  DB 연결( 추후 모듈화로 코드 최적화 필요 )
const mysql = require('../db/maria')();
const connection1 = mysql.init();
mysql.db_open(connection1);

const mysql2 = require('../db/acrV4')();
const connection2 = mysql.init();
mysql2.db_open(connection2);

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
    async fetchQueueInfo() {
        try {
            return Promise.all([
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
                    connection1.query(QueueInfoQuery, [this.userId + 10], (err, results) => {
                        if (err) {
                            logger.error(`[ QueueManager:fetchQueueInfo ] Customer query error: ${err}`);
                            reject(err);
                        }
                        resolve(results[0]);
                    });
                })
            ]).then(([counselorData, customerData]) => {
                // formatQueueInfo 호출 시 rx/tx 구분하여 적절한 queue 정보 반환
                return this.fileType === 'rx' ? this.formatQueueInfo(counselorData) : this.formatQueueInfo(customerData);
            });
        } catch (error) {
            logger.error(`[ QueueManager:fetchQueueInfo ] Error:`, error);
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

        // rx/tx에 따른 큐 선택
        const selectedQueue = this.fileType === 'rx' 
            ? {
                toQueue: erkengineInfo_return_recvQueueName,
                fromQueue: erkengineInfo_return_sendQueueName,
                userId: userinfo_userId,
                type: 'rx'
            } 
            : {
                toQueue: erkengineInfo_returnCustomer_recvQueueName,
                fromQueue: erkengineInfo_returnCustomer_sendQueueName,
                userId: userinfo_userId + 10,  // +1이 아닌 +10으로 수정
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
                QueueInfo: queueInfo,
                OrgId: org_id,
                UserId: selectedQueue.userId,
            }),
            // 오디오 데이터 관련 설정
            AudioRecognitionConfig: ErkApiMsg.create({
                recognitionType: this.fileType === 'rx' ? 1 : 2,
                sampleRate: 16000,
                channels: 1,
                encoding: 1
            })
        };
    
        return {
            selectedQueue,
            queueInfo,
            header,
            chunkConfig
        };
    }

    // 큐 정보 로깅
    logQueueInfo(selectedQueue) {
        logger.info(`[ QueueManager ] ${this.fileType.toUpperCase()} 파일 처리 - 수신 큐: ${selectedQueue.toQueue}, 송신 큐: ${selectedQueue.fromQueue}`);
    }
}

module.exports = {
    QueueManager,
    setErkApiMsg  
}