'use strict'
//  RabbitMQ 스트림 큐를 통한 음성 데이터 전송 및 응답 처리를 담당하는 프로세서

const DateUtils = require('../utils/dateUtils');

const fs = require('fs');

const logger = require('../logs/logger');

const { setErkApiMsg, getErkApiMsg } = require('../utils/erkUtils');
const { options } = require('rhea');
const path = require(`path`);
const { head } = require('request');

const mysql = require('../db/maria')();
const mysql2 = require('../db/acrV4')();

const connection = mysql.pool();
const connection2 = mysql2.pool();

mysql.pool_check(connection);
mysql2.pool_check(connection2);

//  청크 처리 및 메모리 관리 클래스
class StreamProcessor {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate || 16000;
        this.bytesPerSample = options.bytesPerSample || 2;
        this.chunkDuration = options.chunkDuration || 1;
        this.totalChunkSize = options.totalChunkSize || 44000;
        this.rawChunkSize = this.sampleRate * this.bytesPerSample * this.chunkDuration;
        this.maxBufferSize = options.maxBufferSize || 1024 * 1024;
        this.gsm610ChunkSize = options.gsm610ChunkSize || this.rawChunkSize;
        this.chunkNumber =1;
    }

    // 파일 스트림 처리 시작점
    async processFileStream(filePath, currentErkApiMsg, options) {
        // 1. 매개변수 검증
        if (!filePath || typeof filePath !== 'string') { throw new Error('Invalid filePath parameter'); }
        if (!currentErkApiMsg) { throw new Error('Invalid currentErkApiMsg parameter'); }

        const {
            // isLastChunk,
            remainingDataSize, // audioData
            totalFileSize, // numberOfChunks
            gsmHeaderLength,
            fileType,
            userId, // useinfoUserId
            login_id,
            org_id,
            user_uuid,
            selectedQueue
        } = options;

        // options 필수값 검증
        const requiredParams = {
            remainingDataSize,
            gsmHeaderLength,
            fileType,
            userId,
            login_id,
            org_id, 
            user_uuid
        };

        //필수 매개변수 검증
        if (!remainingDataSize || !gsmHeaderLength || !fileType || !userId || !login_id || !org_id || !user_uuid || !selectedQueue){
            throw new Error('Missing required parameters');
        }

        for (const [key, value] of Object.entries(requiredParams)) {
            if (value === undefined || value === null) {
                throw new Error(`Missing required parameter: ${key}`);
            }
        }

        // selectedQueue 검증
        if (!Array.isArray(selectedQueue) || selectedQueue.length < 1 || 
        !selectedQueue[0].erkengineInfo_return_recvQueueName || 
        !selectedQueue[1].erkengineInfo_returnCustomer_sendQueueName) {
            throw new Error('Invalid selectedQueue structure'); 
        }

        try {
            const baseFileName = path.basename(filePath);
            if (!baseFileName.endsWith('.wav')) { throw new Error('Invalid file format - only .wav files are supported'); }
     
            const fileInfo_callId = baseFileName.replace(/\.[^/.]+$/, '').replace(/_[rt]x$/,'');
            if (!fileInfo_callId) { throw new Error('Failed to extract valid callId from filename'); }

            // GSM 6.10 청크를 처리하고 PCM으로 변환
            const processResult = await this.processChunk(
                filePath,
                currentErkApiMsg,
                remainingDataSize,
                fileInfo_callId,
                gsmHeaderLength,
                // isLastChunk,
                fileType,
                options.userId,
                options.login_id,
                options.org_id,
                user_uuid,
                selectedQueue
            );

            // 녹취 완료 여부 확인
            const isRecordingComplete = (remainingDataSize < this.gsm610ChunkSize);

            if (processResult.success) {
                return {
                    success: true,
                    isComplete: isRecordingComplete,  // 녹취 완료 여부 전달
                    message: isRecordingComplete ? 'Final chunk processed successfully' : 'Chunk processed successfully'
                };
            } else {
                return {
                    success: false,
                    isComplete: false,
                    message: processResult.message
                };
            }
        } catch (error) {
            // 2. 에러 처리 강화
            logger.error(`[ StreamProcessor:processFileStream ] Error processing file stream:`, {
                error: error.message,
                stack: error.stack,
                filePath,
                userId
            });

            return {
                success: false,
                message: error.message
            };
        }
    }

    async processChunk(filePath, fileInfo_callId, currentErkApiMsg, remainingDataSize, gsmHeaderLength,
        /*isLastChunk,*/ fileType, userId, login_id, org_id, user_uuid, selectedQueue) {

        // 1. 매개변수 검증
        if (!filePath || !fileInfo_callId || !currentErkApiMsg || !userId || !login_id) {
            throw new Error('Missing required parameters');
        }

        if (!this.gsm610ChunkSize || !this.bytesPerSample) {
            throw new Error('Invalid StreamProcessor configuration');
        }

        const MAX_RETRIES = 3;  // 최대 재시도 횟수
        const RETRY_DELAY = 1000;  // 재시도 간격 (1초)
        let retryCount = 0;

        while (retryCount < MAX_RETRIES) {
            try {
                // 1. 청크 데이터 준비
                const paddedChunk = await this.preparePaddedChunk({
                    filePath,
                    gsmHeaderLength,
                    remainingDataSize,
                    gsm610ChunkSize: this.gsm610ChunkSize,
                    bytesPerSample: this.bytesPerSample
                });

                // 2. 메시지 생성 및 전송
                const currentTimestamp = DateUtils.getCurrentTimestamp();
                const currentDateTimeString = DateUtils.getCurrentDateTimeString(currentTimestamp);

                // 3. DB 기록 및 메시지 전송
                const sendResult = await this.sendAndLog(paddedChunk, {
                    // currentErkApiMsg,
                    fileType,
                    userId,
                    fileInfo_callId,
                    login_id,
                    selectedQueue,
                    user_uuid,
                    org_id,
                    timestamp: currentTimestamp,
                    dateTimeString: currentDateTimeString
                    // isLastChunk
                });

                if (sendResult.success) { return sendResult; }

                // 전송은 됐지만 실패한 경우
                throw new Error(`Failed to send chunk: ${sendResult.message}`);
            } catch (error) {
                retryCount++;
                logger.error(`[ StreamProcessor:processChunk ] Attempt ${retryCount}/${MAX_RETRIES} failed: ${error}`);

                if (retryCount === MAX_RETRIES) {
                    throw new Error(`Failed to process chunk after ${MAX_RETRIES} attempts`);
                }

                // 재시도 전 대기
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }
    }

    async preparePaddedChunk({
        filePath,
        gsmHeaderLength,
        remainingDataSize,
        gsm610ChunkSize,
        bytesPerSample
    }) {
        try {
            // 2. 파일에서 데이터 읽기
            const fileData = await fs.promises.readFile(filePath);

            // 3. GSM 헤더 이후의 데이터 추출
            const audioData = fileData.slice(gsmHeaderLength);
            
            // 4. 청크 크기 계산
            const chunkSize = Math.min(remainingDataSize, gsm610ChunkSize);
            const samplesCount = Math.ceil(chunkSize / bytesPerSample);

            // 5. GSM 청크를 위한 버퍼 준비
            let paddedChunk = new Uint16Array(gsm610ChunkSize / bytesPerSample);

            // 6. 실제 데이터 복사
            const rawChunk = new Uint16Array(audioData.buffer, 0, samplesCount);
            paddedChunk.set(rawChunk);
            
            // remainingDataSize가 gsm610ChunkSize보다 작은 경우 (마지막 청크)
            // 7. 마지막 청크 처리
            if (remainingDataSize < gsm610ChunkSize) {
                logger.info('[ StreamProcessor:preparePaddedChunk ]', {
                    message: 'Last chunk detected',
                    remainingDataSize,
                    actualDataSize: remainingDataSize,
                    paddedSize: gsm610ChunkSize
                });
            }

            logger.info('[ StreamProcessor:processChunk ] Padded chunk created:', {
                samplesToCopy: paddedChunk.samplesToCopy,
                byteArrayLength: paddedChunk.byteArray?.length
            });

            // 8. 결과 반환
            return {
                data: paddedChunk,
                samplesToCopy: paddedChunk.length,
                byteArray: new Uint8Array(paddedChunk.buffer),
                actualDataSize: remainingDataSize,
                paddedSize: gsm610ChunkSize
            };
        } catch (error) {
            logger.error('[ StreamProcessor:preparePaddedChunk ] Error:', {
                error: error.message,
                stack: error.stack,
                filePath,
                remainingDataSize
            });

            throw new Error(`Failed to prepare padded chunk: ${error.message}`);
        }
    }

    //  오디오 청크 전송
    async sendAndLog(paddedChunk, {
        // currentErkApiMsg,
        fileType,
        userId,
        timestamp,
        dateTimeString,
        chunkNumber,
        login_id,
        org_id,
        user_uuid,
        fileInfo_callId,
        selectedQueue
    }) {
        try {
            const { ErkApiMsg, ch, ch2, ErkQueueInfo, ErkQueueInfo2 } = getErkApiMsg();

            // 로깅 추가
            logger.info(`[ StreamProcessor:sendAndLog ] Queue data: ${JSON.stringify(selectedQueue, null, 2)}`);
            logger.info(`[ StreamProcessor:sendAndLog ] Type data: ${JSON.stringify(fileType, null, 2)}`);

            // 1. RX/TX에 따른 헤더와 채널 설정
            const channel = fileType === 'rx' ? ch : ch2;
            // MindSupport 수신 시
            const fromQueue = fileType === 'rx' ? selectedQueue[0].erkengineInfo_return_sendQueueName : selectedQueue[1].erkengineInfo_returnCustomer_sendQueueName ;
            // ETRI로 송신 시
            const toQueue = fileType === 'rx' ? selectedQueue[0].erkengineInfo_return_recvQueueName : selectedQueue[1].erkengineInfo_returnCustomer_recvQueueName ;

            const ErkDataQueueInfo = ErkApiMsg.create({
                ToQueueName: toQueue,
                FromQueueName: fromQueue
            });

            const ErkMsgDataHead = ErkApiMsg.create({
                MsgType: 27,    // v3.3: 17, 전시회:13
                QueueInfo: ErkDataQueueInfo,
                TransactionId: user_uuid,
                OrgId: org_id,
                UserId: userId
            });

            // 2. 메시지 생성
            const sendSpeechMsg = ErkApiMsg.create({
                SpeechEmoRecogRQ: {
                    ErkMsgDataHead: ErkMsgDataHead,
                    DataTimeStamp: timestamp,
                    MsgDataLength: paddedChunk.samplesToCopy * this.bytesPerSample,
                    MsgDataFrame: [paddedChunk.byteArray]
                }
            });            

            // 3. DB 쿼리 수정 (순서와 필드명 명확화)
            const query = `
                INSERT INTO emo_emotion_info (
                    send_dt,
                    login_id, 
                    userinfo_userId,
                    file_name,
                    sendQueueName,
                    recvQueueName,
                    org_id,
                    file_seq,
                    data_length
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

            // 수정된 params (쿼리의 VALUES와 순서 일치)
            const params = [
                dateTimeString,                                   // send_dt
                login_id,                                         // login_id
                userId,                                           // userinfo_userId
                fileInfo_callId,                                  // file_name
                fromQueue,                                        // sendQueueName
                toQueue,                                          // recvQueueName
                org_id,                                           // org_id
                this.chunkNumber,                                 // file_seq
                paddedChunk.samplesToCopy * this.bytesPerSample   // data_length
            ];

            // DB 쿼리 실행을 Promise로 래핑
            await new Promise((resolve, reject) => {
                connection.query(query, params, (err, result) => {
                    if (err) {
                        logger.error(`[ StreamProcessor:sendAndLog ] DB insert error: ${err}`);
                        reject(err);
                    } else {
                        logger.warn(`[ StreamProcessor:sendAndLog ] DB insert succesfully`);
                        resolve(result);
                    }
                });
            });

            // 4. 선택된 채널로 메시지 전송
            const sendSpeechMsg_buf = ErkApiMsg.encode(sendSpeechMsg).finish();
            const sendResult = await channel.sendToQueue(toQueue, sendSpeechMsg_buf, { persistent: true } );

            logger.warn(`[ StreamProcessor:sendSpeechMsg ] 메세지 송신결과\n${JSON.stringify(sendSpeechMsg, (key, value) => {
                // MsgDataFrame 필드는 제외
                if (key === 'MsgDataFrame') {
                    return undefined;
                }
            
                // ErkMsgDataHead 필드를 JSON 형태로 출력
                if (key === 'ErkMsgDataHead') {
                    return value; // 객체 그대로 반환 (세분화된 JSON으로 출력)
                }
            
                // 특정 필드에 대해 포맷 변경
                if (key === 'DataTimeStamp' || key === 'MsgDataLength') {
                    return `[ ${value} ]`;
                }
            
                return value; // 나머지 필드는 그대로 반환
            }, 4)}`);

            if (!sendResult) {
                throw new Error(`Failed to send message to ${fileType} queue: ERK_API_QUEUE`);
            }

            this.chunkNumber++;

            return {
                success: true,
                message: `Successfully sent ${fileType} chunk ${chunkNumber}`
            };
        } catch(err) {
            logger.error(`[ StreamProcessor:sendAndLog ] Error processing ${fileType} chunk ${chunkNumber}:`, err);
            logger.error(`[ StreamProcessor:sendAndLog ] Stack:`, err.stack);
            
            throw new Error(`${fileType} chunk processing failed: ${err.message}`);
        }
    }

    // 긴급 상황 시 리소스 정리
    cleanup() {
        for (const [streamId, streamInfo] of this.activeStreams) {
            streamInfo.stream.destroy();
            this.activeStreams.delete(streamId);
        }
    }
}

module.exports = StreamProcessor