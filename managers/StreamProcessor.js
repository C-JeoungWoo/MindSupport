'use strict'
//  RabbitMQ 스트림 큐를 통한 음성 데이터 전송 및 응답 처리를 담당하는 프로세서

const DateUtils = require('../utils/dateUtils');

const logger = require('../logs/logger');

const { getErkApiMsg } = require('../utils/erkUtils');
const { options } = require('rhea');

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
    }

    // 파일 스트림 처리 시작점
    async processFileStream(filePath, currentErkApiMsg, options) {
        const {
            isLastChunk,
            remainingDataSize,
            totalFileSize,
            gsmHeaderLength,
            fileType,
            userId,
            login_id,
            org_id,
            user_uuid
        } = options;

        // let successCount = 0;
        try {
            // GSM 6.10 청크를 처리하고 PCM으로 변환
            const processResult = await this.processChunk(
                filePath,
                currentErkApiMsg,
                remainingDataSize,
                gsmHeaderLength,
                isLastChunk,
                fileType,
                userId,
                login_id,
                org_id,
                user_uuid
            );

            // 분할 횟수만큼 순차적 전송
            // for(let i = 0; i<totalChunks; i++) {
            //     try {
            //         const start = i * (this.rawChunkSize / this.bytesPerSample);
            //         const end = Math.min(start + (this.rawChunkSize / this.bytesPerSample), audioData.length);
            //         const chunk = audioData.slice(start, end);

            //         // 청크 처리
            //         await this.processChunk(chunk, options, i, totalChunks);
            //         successCount++;
            
            //         logger.warn(`[ app.js:StreamProcessor ] Chunk ${i+1} sent successfully`);
            //     } catch (error) {
            //         logger.error(`[ app.js:StreamProcessor ] Error sending chunk ${i+1}:`, error);
            //         // 오류 발생 시 재시도 로직
            //         await new Promise(resolve => setTimeout(resolve, 1000)); // 1초 대기
            //         i--; // 현재 청크 재시도
            //         continue;
            //     }
            // }

            // 전송 결과 확인
            // if (successCount === totalChunks) {
            //     return { 
            //         success: true, 
            //         message: 'All chunks sent successfully',
            //         totalChunks,
            //         successCount
            //     };
            // } else {
            //     return { 
            //         success: false, 
            //         message: `Only ${successCount} out of ${totalChunks} chunks sent successfully`,
            //         totalChunks,
            //         successCount
            //     };
            // }

            if (processResult.success) {
                return {
                    success: true,
                    message: isLastChunk ? 'Final chunk processed successfully' : 'Chunk processed successfully'
                };
            } else {
                return {
                    success: false,
                    message: processResult.message
                };
            }
        } catch (error) {
            logger.error(`[ StreamProcessor:processFileStream ] Error processing file stream: ${error}`);
            return { 
                success: false, 
                error: error.message,
                // totalChunks,
                // successCount
            };
        }
    }

    async processChunk(filePath, currentErkApiMsg, remainingDataSize, gsmHeaderLength, isLastChunk, fileType, userId, header) {
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
                    currentErkApiMsg,
                    header,
                    fileType,
                    userId,
                    timestamp: currentTimestamp,
                    dateTimeString: currentDateTimeString
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
        // GSM 청크를 위한 버퍼 준비
        let paddedChunk = new Uint16Array(gsm610ChunkSize / bytesPerSample);

        // if (isLastChunk && chunk.length < (rawChunkSize / bytesPerSample)) {
        //     logger.info(`[ StreamProcessor:preparePaddedChunk ] Last chunk detected - Actual samples: ${chunk.length}, Padding to: ${rawChunkSize / bytesPerSample}`);
        //     paddedChunk.set(chunk);
            
        //     const actualDataSize = chunk.length * bytesPerSample;
        //     const paddedSize = totalChunkSize;
        //     logger.info(`[ StreamProcessor:preparePaddedChunk ] Last chunk padding - Real data: ${actualDataSize} bytes, Padded to: ${paddedSize} bytes`);
        // } else {
        //     const samplesToCopy = Math.min(chunk.length, rawChunkSize / bytesPerSample);
        //     paddedChunk.set(chunk.subarray(0, samplesToCopy));
        // }
        
        // remainingDataSize가 gsm610ChunkSize보다 작은 경우 (마지막 청크)
        if (remainingDataSize < gsm610ChunkSize) {
            logger.info(`[ StreamProcessor:preparePaddedChunk ] Last chunk detected - Remaining data: ${remainingDataSize} bytes`);
            
            // 남은 데이터 크기만큼만 처리
            const actualDataSize = remainingDataSize;
            const paddedSize = gsm610ChunkSize;
            logger.info(`[ StreamProcessor:preparePaddedChunk ] Last chunk padding - Real data: ${actualDataSize} bytes, Padded to: ${paddedSize} bytes`);
        }

        return {
            data: paddedChunk,
            samplesToCopy: paddedChunk.length,
            byteArray: new Uint8Array(paddedChunk.buffer)
        };
    }

    //  오디오 청크 전송
    async sendAndLog(paddedChunk, {
        currentErkApiMsg,
        header,
        fileType,
        userId,
        timestamp,
        dateTimeString,
        chunkNumber,
        login_id,
        org_id,
        fileInfo_callId,
        selectedQueue
    }) {
        try {
            // const { chunkIndex, totalChunks, timestamp, dateTimeString, fileType } = options; // fileType 추가
            const { ErkApiMsg, ch, ch2, ErkQueueInfo, ErkQueueInfo2 } = currentErkApiMsg;

            // 1. RX/TX에 따른 헤더와 채널 설정
            const channel = fileType === 'RX' ? ch : ch2;
            const queueInfo = fileType === 'RX' ? ErkQueueInfo : ErkQueueInfo2;

            // 2. 메시지 생성
            const sendSpeechMsg = ErkApiMsg.create({
                SpeechEmoRecogRQ: {
                    ErkMsgDataHead: header,
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
                    dateTimeString,                                    // send_dt
                    login_id,                                         // login_id
                    userId,                                           // userinfo_userId
                    fileInfo_callId,                                  // file_name
                    selectedQueue.fromQueue,                          // sendQueueName
                    selectedQueue.toQueue,                            // recvQueueName
                    org_id,                                           // org_id
                    chunkNumber,                                      // file_seq
                    paddedChunk.samplesToCopy * this.bytesPerSample  // data_length
                ];
            
            // DB 쿼리 실행을 Promise로 래핑
            await new Promise((resolve, reject) => {
                connection1.query(query, params, (err, result) => {
                    if (err) {
                        logger.error(`[ StreamProcessor:sendAndLog ] DB insert error: ${err}`);
                        reject(err);
                    }
                    resolve(result);
                });
            });

            // 4. 선택된 채널로 메시지 전송
            const sendSpeechMsg_buf = ErkApiMsg.encode(sendSpeechMsg).finish();
            const sendResult = await channel.sendToQueue(
                "ERK_API_QUEUE",
                sendSpeechMsg_buf,
                { persistent: true }
            );

            if (!sendResult) {
                throw new Error(`Failed to send message to ${fileType.toUpperCase()} queue: ERK_API_QUEUE`);
            }

            return {
                success: true,
                message: `Successfully sent ${fileType} chunk ${chunkNumber}`
            };
        } catch(err) {
            logger.error(`[ StreamProcessor:sendAndLog ] Error processing ${fileType.toUpperCase()} chunk ${chunkNumber}:`, err);
            logger.error(`[ StreamProcessor:sendAndLog ] Stack:`, err.stack);
            
            throw new Error(`${fileType.toUpperCase()} chunk processing failed: ${err.message}`);
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