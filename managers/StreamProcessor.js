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
        this.chunkNumber = 1;
    }

    // 파일 스트림 처리 시작점
    async processFileStream(filePath, currentErkApiMsg, chunkNumber, options) {
        // 1. 매개변수 검증
        if (!filePath || typeof filePath !== 'string') { throw new Error('Invalid filePath parameter'); }
        if (!currentErkApiMsg) { throw new Error('Invalid currentErkApiMsg parameter'); }

        const {
            audioData,
            pcmDataSize, // options.totalFileSize
            numberOfChunks, // numberOfChunks
            rawChunkSize,
            totalChunkSize,
            remainingDataSize, // audioData
            gsmHeaderLength,
            userId, // useinfoUserId
            fileInfo_callId,
            fileType,
            login_id,
            org_id,
            user_uuid,
            selectedQueue
        } = options;

        logger.error(`processFileStream options.pcmDatasize : ${options.pcmDataSize}`);

        // options 필수값 검증
        const requiredParams = {
            remainingDataSize,
            gsmHeaderLength,
            fileType,
            userId,
            login_id,
            org_id, 
            user_uuid,
            selectedQueue
        };

        //필수 매개변수 검증
        if (!remainingDataSize || !numberOfChunks || !gsmHeaderLength || !fileType || !userId || !login_id || !org_id || !user_uuid || !selectedQueue){
            throw new Error('Missing required parameters');
        }

        for (const [key, value] of Object.entries(requiredParams)) {
            if (value === undefined || value === null) {
                throw new Error(`Missing required parameter: ${key}`);
            }
        }

        // selectedQueue 검증
        if (!Array.isArray(selectedQueue) || selectedQueue.length < 1) {
            throw new Error('Invalid selectedQueue structure'); 
        }

        try {
            // 파일 유효성 검증
            const baseFileName = path.basename(filePath);
            if (!baseFileName.endsWith('.wav')) {throw new Error('Invalid file format - only .wav files are supported');}
     
            const fileInfo_callId = baseFileName.replace(/\.[^/.]+$/, '').replace(/_[rt]x$/,'');
            if (!fileInfo_callId) {throw new Error('Failed to extract valid callId from filename');}

            logger.info('processFileStream data:', {
                pcmDataSize : options.pcmDatasize,
                remainingDataSize,
                currentChunk: chunkNumber,
                expectedTotalChunks: Math.ceil(pcmDataSize / 44000)
            });

            const processResult = await this.processChunk(
                filePath,
                fileInfo_callId,
                remainingDataSize,
                gsmHeaderLength,
                fileType,
                options.userId,
                options.login_id,
                options.org_id,
                user_uuid,
                selectedQueue,
                currentErkApiMsg,
                pcmDataSize, // 20250113 수정 processFileStream으로부터 options.totalFileSize를 전달받음
                chunkNumber
            );

            // 결과 반환
            if (processResult.success) {
                return {
                    success: true,
                    message: 'Chunk processed successfully'
                };
            } 
            
            return {
                success: false,
                message: processResult.message
            };
        } catch (error) {
            // 2. 에러 처리 강화
            logger.error('[ StreamProcessor:processFileStream ] Error:', {
                error: error.message,
                stack: error.stack,
                filePath,
                userId: options.userId
            });

            return {
                success: false,
                message: error.message
            };        
        }
    }

    // 청크 처리
    async processChunk(filePath, fileInfo_callId, remainingDataSize, gsmHeaderLength,
        fileType, userId, login_id, org_id, user_uuid, selectedQueue, currentErkApiMsg, pcmDataSize, chunkNumber) {

        // 1. 매개변수 검증
        if (!filePath || !fileInfo_callId || !userId || !login_id) { throw new Error('[ StreamProcessor:processFileStream ] Missing required parameters'); }
        if (!pcmDataSize || !this.bytesPerSample) { throw new Error('[ StreamProcessor:processFileStream ] Invalid StreamProcessor configuration'); }

        try {
            // 1. 청크 데이터 준비
            const paddedChunk = await this.preparePaddedChunk({
                filePath,
                gsmHeaderLength,
                remainingDataSize,
                totalChunkSize: pcmDataSize,
                bytesPerSample: this.bytesPerSample
            });

            // 2. 메시지 생성 및 전송
            const currentTimestamp = DateUtils.getCurrentTimestamp();
            const currentDateTimeString = DateUtils.getCurrentDateTimeString(currentTimestamp);

            // 3. DB 기록 및 메시지 전송
            const sendResult = await this.sendAndLog(paddedChunk, {
                fileType,
                userId,
                timestamp: currentTimestamp,
                dateTimeString: currentDateTimeString,
                fileInfo_callId,
                login_id,
                selectedQueue,
                user_uuid,
                org_id,
                pcmDataSize, // 202501 수정 options.totalFileSize 를 넘겨받음
                chunkNumber
            });

            if (sendResult.success) { 
                return sendResult;
            } else {
                throw new Error(`[ StreamProcessor:processFileStream ] Failed to send chunk: ${sendResult.message}`);
            }
        } catch (error) {
            logger.error(`[ StreamProcessor:processFileStream ] Error: `, {
                error: error.message,
                stack: error.stack,
                context: {
                    filePath,
                    fileType,
                    userId,
                    chunkNumber: this.chunkNumber,
                    remainingDataSize
                }
            });
        }
    }

    // 분할된 오디오 청크 준비
    async preparePaddedChunk({
        filePath,
        gsmHeaderLength,
        remainingDataSize,
        totalChunkSize, // pcmDatasize를 받아옴
        bytesPerSample,
        chunkNumber
    }) {
        try {
            // 파일 데이터 읽기
            const fileData = await fs.promises.readFile(filePath);
            const audioData = fileData.slice(gsmHeaderLength);
            
            // 청크 크기 계산
            const chunkSize = Math.min(remainingDataSize, totalChunkSize);
            logger.error(`[ StreamProcessor.js:preparePaddedChunk ] pcmDataSize(totalChunkSize) 체크 용 로깅 : ${totalChunkSize}`);
            
            // GSM 청크를 위한 버퍼 준비
            const currentOffset = (chunkNumber-1) * this.rawChunkSize;
            let paddedChunk = new Uint16Array(44000 / bytesPerSample); // 44000바이트 고정 버퍼 생성 (22000 samples)

            // 실제 복사할 데이터 크기 계산 (32000바이트 또는 남은 크기)
            const actualDataSize = Math.min(0, Math.min(32000, remainingDataSize)); // 음수가 나오지 않도록 보장
            const samplesCount = Math.floor(actualDataSize / bytesPerSample) * 2; // 홀수 바이트의 데이터를 할당할 때 오류 발생할 수 있음. ceil(x)

            // 실제 데이터 복사 (바이트 정렬 보장)
            const rawChunk = new Uint16Array(
                audioData.buffer.slice(
                    audioData.byteOffset - (audioData.byteOffset % 2), //2바이트 정렬 보장
                    audioData.byteOffset + samplesCount
                )
            );
            paddedChunk.set(rawChunk.subarray(0, samplesCount));

            const remainingPcm = totalChunkSize - actualDataSize; // 로깅용... 추후 삭제 필요
            logger.info(`[ StreamProcessor.js:preparePaddedChunk ] Chunk preparation: 44000(totalSize) | remainingDataSize : ${remainingDataSize} | actualDataSize : ${actualDataSize} | samplesCount : ${samplesCount} | remainingPcm : ${remainingPcm}` ); 
    
            // 마지막 청크 로깅
            if (remainingDataSize < totalChunkSize) {
                logger.info('[ StreamProcessor.js:preparePaddedChunk ]', {
                    message: 'Last chunk detected',
                    remainingDataSize,
                    actualDataSize: remainingDataSize,
                    paddedSize: totalChunkSize,
                    samplesCount,
                    paddedLength: paddedChunk.length
                });
            }
    
            // 결과 반환
            return {
                data: paddedChunk,
                samplesToCopy: paddedChunk.length,
                byteArray: new Uint8Array(paddedChunk.buffer),
                actualDataSize: remainingDataSize,
                paddedSize: totalChunkSize
            };
        } catch (error) {
            logger.error(`[ StreamProcessor:preparePaddedChunk ] Error: ${error}`);
            throw error;
        }
    }

    //  오디오 청크 전송
    async sendAndLog(paddedChunk, {
        fileType,
        userId,
        timestamp,
        dateTimeString,
        login_id,
        org_id,
        user_uuid,
        fileInfo_callId,
        selectedQueue,
        pcmDataSize,
        chunkNumber
    }) {
        try {
            const { ErkApiMsg, ch, ch2, ErkQueueInfo, ErkQueueInfo2 } = getErkApiMsg();
            const currentChunkSize = (pcmDataSize / paddedChunk.paddedSize); // 20

            // 1. RX/TX에 값 설정
            const channel = fileType === 'rx' ? ch : ch2;
            //      - MindSupport 수신 시
            const fromQueue = fileType === 'rx' ? selectedQueue[0].erkengineInfo_return_sendQueueName : selectedQueue[0].erkengineInfo_returnCustomer_sendQueueName;
            //      - ETRI로 송신 시
            const toQueue = fileType === 'rx' ? selectedQueue[0].erkengineInfo_return_recvQueueName : selectedQueue[0].erkengineInfo_returnCustomer_recvQueueName;

            const ErkDataQueueInfo = ErkApiMsg.create({
                ToQueueName: toQueue,
                FromQueueName: fromQueue
            });

            const ErkMsgDataHead = ErkApiMsg.create({
                MsgType: 27,
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

            // 3. 음성 데이터 송신 정보 저장(순서, 필드명 명확화!)
            const query = `
                INSERT INTO emo_emotion_info (
                    send_dt,
                    login_id, 
                    userinfo_userId,
                    cusinfo_userId,
                    file_name,
                    sendQueueName,
                    recvQueueName,
                    org_id,
                    file_seq,
                    data_length,
                    EmoRecogTime
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

            // 수정된 params (쿼리의 VALUES와 순서 일치)
            const params = [
                dateTimeString,                                   // send_dt
                login_id,                                         // login_id
                fileType === 'rx' ? userId : null,                // userinfo_userId
                fileType === 'tx' ? userId : null,                // cusinfo_userId
                fileInfo_callId,                                  // file_name
                fromQueue,                                        // sendQueueName
                toQueue,                                          // recvQueueName
                org_id,                                           // org_id
                chunkNumber,                                      // file_seq
                currentChunkSize,                                 // data_length
                timestamp                                         // EmoRecogTime
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
                throw new Error(`Failed to send message to ${fileType} queue: ${toQueue}`);
            }

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