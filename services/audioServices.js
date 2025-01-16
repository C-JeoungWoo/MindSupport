'use strict'

const DateUtils = require('../utils/dateUtils');
const StreamProcessor = require('../managers/StreamProcessor');
const streamProcessor = new StreamProcessor();
const StreamingService = require(`../services/streamingService`);
const AudioFileManager = require(`../managers/AudioFileManager`);
const audioFileManager = new AudioFileManager();

const fs = require('fs');

const { setErkApiMsg, getErkApiMsg } = require('../utils/erkUtils');

const logger = require('../logs/logger');
const fsp = require('fs').promises;
const path = require('path');

const mysql = require('../db/maria')();
const connection1 = mysql.pool();
mysql.pool_check(connection1);

const mysql2 = require('../db/acrV4')();
const connection2 = mysql2.pool();
mysql2.pool_check(connection2);

//  생성된 WAV 파일 처리
const handleNewFile = async function handleNewFile(filePath, userInfoUserId, serviceResponse, type) {
    logger.info(`[ audioServices.js:handleNewFile ] 처리요청 받은 RX/TX 파일경로: ${filePath}`);

    const baseFileName = path.basename(filePath, '.wav');
    const caller_id = baseFileName.split('_')[2];

    let fileType = filePath.includes('rx') ? 'rx' : 'tx';
    
    if (filePath.includes('_tx')) {
        userInfoUserId = userInfoUserId + 3;
    }

    // 통화 파일 정보 등록 //20250109 추가
    audioFileManager.pendingFiles.set(filePath, {
       fileTypeInfo : { fileType: '' }
    });

    // 통화 정보 등록/업데이트 //20250109 추가
    if (!audioFileManager.callTracker.has(caller_id)) {
        audioFileManager.callTracker.set(caller_id, {
            rx: { status: 'pending' },
            tx: { status: 'pending' }
        });
    }

    // ErkApiMsg 상태 확인
    const currentErkApiMsg = getErkApiMsg();
    logger.info(`[ audioServices.js:EmoServiceStartRQ ] Current ErkApiMsg status: ${currentErkApiMsg  ? 'defined' : 'undefined'}`);

    try {
        // 4. StreamQueue 설정 완료 대기
        const waitForStreamQueue = () => {
            return new Promise((resolve, reject) => {
                const checkInterval = setInterval(async () => {
                    try {
                        // DB에서 StreamQueue 설정 상태 확인
                        const queueStatus = await new Promise((resolveQuery, rejectQuery) => {
                            const chk_queue_qry = `SELECT 
                                    erkengineInfo_return_sendQueueName,
                                    erkengineInfo_returnCustomer_sendQueueName,
                                    erkengineInfo_return_recvQueueName,
                                    erkengineInfo_returnCustomer_recvQueueName 
                                FROM emo_user_info 
                                WHERE userinfo_userId = ${userInfoUserId}`;
                            connection1.query(chk_queue_qry, (error, results) => {
                                    if (error) rejectQuery(error);
                                    logger.warn(chk_queue_qry);
                                    resolveQuery(results);
                                }
                            );
                        });

                        // StreamQueue가 설정되었는지 확인
                        if (queueStatus[0].erkengineInfo_return_recvQueueName || queueStatus[0].erkengineInfo_returnCustomer_recvQueueName) {
                            logger.warn(`[ audioServices.js:handleNewFile ] Check Stream Queue ${JSON.stringify(queueStatus, null, 2)}`);
                            clearInterval(checkInterval);
                            resolve(queueStatus);
                        }
                    } catch (error) {
                        clearInterval(checkInterval);
                        reject(error);
                    }
                }, 100); // 100ms 간격으로 체크

                // 10초 타임아웃 설정
                setTimeout(() => {
                    clearInterval(checkInterval);
                    reject(new Error('StreamQueue setup timeout'));
                }, 10000);
            });
        };

        // StreamQueue 설정 완료 대기
        const queueStatus = await waitForStreamQueue();
        logger.info(`[ audioServices.js:handleNewFile ] StreamQueue setup completed`);

        // GSM 6.10 WAV 파일 무결성 및 헤더 길이 체크
        const result  = await checkGsm610WavFileIntegrity(filePath);
        if (result.status !== 'valid') {
            logger.warn(`[ audioServices.js:checkGsm610WavFileIntegrity ] New file is invalid`);
            return null;
        }
        const { gsmHeaderLength } = result;  // result에서 gsmHeaderLength 추출
        logger.info(`[ audioServices.js:checkGsm610WavFileIntegrity ] File integrity check passed, header length: ${gsmHeaderLength} bytes`);

        // let previousSize = 0;
        let unchangedCount = 0;
        let chunkNumber = 1;
        let lastSize = 0;
        const MAX_UNCHANGED_COUNT = 30;  // 3초

        while (true) {
            const fileStats = await fsp.stat(filePath);
            const currentSize = fileStats.size;

            if (currentSize === lastSize) {
                unchangedCount++;
                if (unchangedCount >= MAX_UNCHANGED_COUNT) {
                    const originalDataSize = currentSize - gsmHeaderLength;
                    const pcmDataSize = originalDataSize * (32000/1630);  // 1초 GSM(1630) -> PCM(32000) 비율
                    const totalMessages = Math.ceil(pcmDataSize / 44000);  // 44000바이트 단위로 분할

                    break;
                }
            } else {
                unchangedCount = 0;
                lastSize = currentSize;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        while (true) {
            try {
                // 1. 현재 상태 체크
                const [fileStats, recordingStatus] = await Promise.all([
                    fsp.stat(filePath),
                    new Promise((resolve, reject) => {
                        let recordingStatus_qry = `SELECT REC_END_DATETIME 
                        FROM acr_v4.t_rec_data${DateUtils.getYearMonth()}
                        WHERE AGENT_TELNO = '${caller_id}'
                        AND DATE(REC_START_DATE) = CURDATE()
                        ORDER BY REC_START_DATE DESC LIMIT 1;`;
                        connection2.query(recordingStatus_qry, (error, results) => {
                            if (error) reject(error);
                            resolve(results[0]);
                        });
                    })
                ]);

                // 2. 파일 크기 변화 체크
                const currentSize = fileStats.size;
                // 3. 파일 크기 안정화 카운트
                if (currentSize !== lastSize) {
                    lastSize = currentSize;
                    unchangedCount = 0;
                } else {
                    unchangedCount++;
                }     

                const originalDataSize = currentSize - gsmHeaderLength; // GSM 원본 데이터
                const pcmDataSize = originalDataSize * (32000/1630);  // 1초 GSM(1630) -> PCM(32000) 비율
                const totalMessages = Math.ceil(pcmDataSize / 44000);  // 44000바이트 단위로 분할
                // const isFileSizeUnchanged = currentSize === previousSize;
                let remainingDataSize = pcmDataSize - (44000 * (chunkNumber - 1));// 파일 크기 안정화

                const expectedChunks = Math.ceil(originalDataSize / 1630);


                logger.info(`Data size check: ${originalDataSize}, ${expectedChunks}, ${totalMessages}, ${chunkNumber}`);//250113 수정
                
                
                // if (isFileSizeUnchanged) unchangedCount++;
                // else unchangedCount = 0;

                // 4. 녹취 종료 조건 체크(DB 종료 및 파일 크기 안정화)
                const isRecordingComplete = (recordingStatus.REC_END_DATETIME !== null) && (unchangedCount >= MAX_UNCHANGED_COUNT); // 청크 31찍히는거 의심

                
                logger.info('handleNewFile calculations:', {
                    currentSize,
                    gsmHeaderLength,
                    originalDataSize,
                    pcmDataSize,
                    totalMessages,
                    currentChunk: chunkNumber,
                    remainingDataSize: pcmDataSize - (44000 * (chunkNumber - 1))
                });

                
                if (isRecordingComplete) {  // 마지막 청크 처리
                    logger.info(`[ audioServices.js:handleNewFile ] Recording completed.
                    DB Status: ${!!recordingStatus.REC_END_DATETIME}, File Stable: ${unchangedCount >= MAX_UNCHANGED_COUNT}`);
                    
                    // 마지막 청크 처리를 위한 sendAudioChunks 호출
                    const sendResult = await StreamingService.sendAudioChunks(
                        filePath,
                        userInfoUserId,
                        chunkNumber,
                        {
                            remainingDataSize: remainingDataSize,   // 남은 데이터 크기
                            totalFileSize: pcmDataSize, // 전체 파일 크기
                            gsmHeaderLength: gsmHeaderLength,   // WAV 헤더 크기
                            fileType: filePath.includes('rx') ? 'rx' : 'tx',  // rx 또는 tx
                            selectedQueue: queueStatus, // 큐 이름 전달
                            login_id: serviceResponse.login_id,
                            org_id: serviceResponse.org_id,
                            user_uuid: serviceResponse.user_uuid
                        }
                    );
                    
                    if (sendResult.message !== 'Chunk processed successfully') {
                        logger.error(`[ audioServices.js:sendAudioChunks ] Failed to send audio chunk ${chunkNumber}: ${sendResult.message}`);
                        logger.error(`[ audioServices.js:sendAudioChunks ] 모든 청크 처리 실패.`);
                    } else {
                        logger.info(`[ audioServices.js:sendAudioChunks ] Successfully processed final chunk ${chunkNumber}`);
                        
                        const handleProcessingComplete_result = await audioFileManager.handleProcessingComplete(filePath, userInfoUserId);
                        // 디버깅용 로깅 추가
                        logger.error(`[ audioServices.js:sendAudioChunks ] handleProcessingComplete 반환값: ${handleProcessingComplete_result}`);

                        if(handleProcessingComplete_result === false) {
                            logger.error(`[ audioServices.js:sendAudioChunks ] 모든 청크 처리 실패 2 : ${handleProcessingComplete_result}`);
                        } else {
                            logger.info(`[ audioServices.js:sendAudioChunks ] 모든 청크 처리 완료.`);
                        }
                    }
                } else { // 미완료된 청크 처리
                    logger.info(`[ audioServices.js:handleNewFile ] Recording uncompleted.`);

                    const sendResult = await StreamingService.sendAudioChunks(
                        filePath, 
                        userInfoUserId,
                        chunkNumber,
                        {
                            remainingDataSize: remainingDataSize,   // 남은 데이터 크기
                            totalFileSize: pcmDataSize, // 전체 파일 크기
                            gsmHeaderLength: gsmHeaderLength,   // WAV 헤더 크기
                            fileType: filePath.includes('rx') ? 'rx' : 'tx',  // rx 또는 tx
                            selectedQueue: queueStatus, // 큐 이름 전달
                            login_id: serviceResponse.login_id,
                            org_id: serviceResponse.org_id,
                            user_uuid: serviceResponse.user_uuid
                        }
                    );
                    logger.info(`[ audioServices.js:sendAudioChunks ] Final chunk processed with ${remainingDataSize} bytes of data`);
                    
                    if (sendResult.message !== 'success') {
                        logger.error(`[ audioServices.js:sendAudioChunks ] Failed to send audio chunk ${chunkNumber}: ${sendResult.message}`);
                    }
                    logger.info('Chunk processing:', {
                        chunkNumber,
                        remainingDataSize,
                        expectedChunks,
                        isComplete: isRecordingComplete
                    });
                    chunkNumber++;
                }

                // 7. 상태 업데이트
                // previousSize = currentSize;
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                logger.error(`[ audioServices.js:handleNewFile ] 9999 Error\n ${error.message} \n${error.stack}\n${filePath}\n${userInfoUserId} `);
                continue;
            }
        }
    } catch(err) {
        logger.error(`[ audioServices.js:handleNewFile ] Error handling file ${filePath}`);
        logger.error(`[ audioServices.js:handleNewFile ] ${err}`);
    }
}

//  생성된 wav 파일 처리에 대해 스트림 채널 할당 요청
const EmoServiceStartRQ = async function EmoServiceStartRQ (path) {
    // EmoServiceStartRQ 함수 시작 부분에 erkUtils에서 값 가져오기
    const { ErkApiMsg, ch, ch2, ErkQueueInfo, ErkQueueInfo2 } = getErkApiMsg();

    try {
        logger.info(`[ audioServices.js:EmoServiceStartRQ ] Current ErkApiMsg status: ${ErkApiMsg  ? 'defined' : 'undefined'}`);
        logger.info(`[ audioServices.js:EmoServiceStartRQ ] 전달받은 File Path: ${path}`);

        // Promise.all을 사용한 병렬 쿼리 실행
        //  - 파일명에서 내선번호로 JOIN
        let caller_id = path.split('_')[2].replace('.wav', '');  // ex. '2501'만 추출

        const [connResults, conn2Results] = await Promise.all([
            //  MindSupport Database → 전체 유저 중 활성 세션 유저 조회
            new Promise((resolve, reject) => {
                connection1.query(`SELECT
                        session_id,
                        JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.org_id')) as user_orgid,
                        JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.userinfo_uuid')) as user_uuid,
                        JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.cusinfo_uuid')) as user_uuid2,
                        eui.*
                    FROM sessions s
                    LEFT JOIN emo_user_info eui
                        ON eui.login_id = JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.login_id'));`, (error, results) => {
                    if (error) { reject(error); }
                    logger.info(`[ audioServices.js:EmoServiceStartRQ ] 현재 세션이 활성된 유저: ${JSON.stringify(results[0], null, 2)}`);
                    
                    resolve(results);
                });
            }),
            //  녹취 Database → 해당 내선번호의 유저 조회
            new Promise((resolve, reject) => {
                // 1. 테이블 존재 여부 확인
                connection2.query(
                    `SHOW TABLES FROM acr_v4 LIKE 't_rec_data${DateUtils.getYearMonth()}'`, 
                    (error, tables) => {
                        if (error) {
                            logger.error(`[ audioServices.js:EmoServiceStartRQ ] DB Error checking tables: ${error}`);
                            reject(error);
                            return;
                        }

                        if (tables.length === 0) {
                            logger.info(`[ audioServices.js:EmoServiceStartRQ ] Table t_rec_data${DateUtils.getYearMonth()} not found`);
                            resolve([]);
                            return;
                        }

                        // 2. 테이블이 존재하면 데이터 조회
                        connection2.query(
                            `SELECT * FROM acr_v4.t_rec_data${DateUtils.getYearMonth()} 
                            WHERE AGENT_TELNO = ?`, [`${caller_id}`], (error, results) => {
                                if (error) {
                                    logger.error(`[ audioServices.js:EmoServiceStartRQ ] DB Error querying data: ${error}`);
                                    reject(error);
                                    return;
                                }
                                logger.info(`[ audioServices.js:EmoServiceStartRQ ] 녹취 DB 조회 결과: ${JSON.stringify(results[0].AGENT_TELNO, null, 2)}`)
                                resolve(results);
                            }
                        );
                    }
                );
            })
        ]);

        if (connResults.status === 'rejected') {
            logger.error(`[ audioServices.js:EmoServiceStartRQ ] Error in connection1 query: ${connResults.reason}`);
        }
        if (conn2Results.status === 'rejected') {
            logger.error(`[ audioServices.js:EmoServiceStartRQ ] Error in connection2 query: ${conn2Results.reason}`);
        }

        // 조인 로직 최적화 (Map 사용)
        const remoteMap = new Map( conn2Results.map(row => [row.rec_id, row]) );
        const joinedData = connResults.map(localRow => ({
            ...localRow,
            ...remoteMap.get(localRow.rec_id)
        }));

        //  ESSRQ 메세지 헤더 구성
        let ErkMsgHead = ErkApiMsg.create({
            MsgType: 21,
            TransactionId: joinedData[0].user_uuid,
            QueueInfo: ErkQueueInfo,
            OrgId: parseInt(joinedData[0].user_orgid),
            UserId: parseInt(joinedData[0].userinfo_userId)  // 상담원3명 셋팅(고객은 userinfo_userId+ 3 로 매핑)
        });
        let ErkMsgHead_cus = ErkApiMsg.create({
            MsgType: 21,
            TransactionId: joinedData[0].user_uuid2,
            QueueInfo: ErkQueueInfo2,
            OrgId: parseInt(joinedData[0].user_orgid),
            UserId: parseInt(joinedData[0].userinfo_userId) + 3
        });

        //  ESSRQ 메세지 구성
        let EmoServiceStartMsg = ErkApiMsg.create({
            EmoServiceStartRQ: {
                ErkMsgHead: ErkMsgHead,
                MsgTime: DateUtils.getCurrentTimestamp(), // 년월일시분초밀리초
                ServiceType: joinedData[0].userinfo_serviceType,
                EmoRecogType: 1    // 개인감성 or 사회감성
            }
        });
        let EmoServiceStartMsg_cus = ErkApiMsg.create({
            EmoServiceStartRQ: {
                ErkMsgHead: ErkMsgHead_cus,
                MsgTime: DateUtils.getCurrentTimestamp(),
                ServiceType: joinedData[0].userinfo_serviceType,
                EmoRecogType: 1
            }
        });
        
        //  메세지 인코딩
        let EmoServiceStartMsg_buf = ErkApiMsg.encode(EmoServiceStartMsg).finish();
        let EmoServiceStartMsg_buf_cus = ErkApiMsg.encode(EmoServiceStartMsg_cus).finish();

        // 3. DB 업데이트 및 메시지 전송 후 응답 대기
        const sendAndWaitForResponse = () => {
            return new Promise(async (resolve, reject) => {
                const channelPromises = [
                    // Channel 1 전송 및 응답 대기
                    new Promise((resolveChannel) => {
                        const userId = parseInt(joinedData[0].userinfo_userId);
                        const query = `UPDATE emo_user_info SET erkEmoSrvcStart_send_dt = NOW(3) WHERE userinfo_userId = ${userId}`;

                        // 실행되는 쿼리 확인
                        logger.info(`[ audioServices.js:EmoServiceStartRQ ] Executing query: ${query}`);

                        connection1.query(query, (error, results) => {
                            if (error) reject(error);        
                            resolveChannel(results);
                        });

                        // 메시지 전송
                        logger.info(`[ audioServices.js:EmoServiceStartRQ ] con 업데이트 후 메세지 송신\n${JSON.stringify(EmoServiceStartMsg, null, 4)}`);
                        ch.sendToQueue("ERK_API_QUEUE", EmoServiceStartMsg_buf);
                    }),
                    // Channel 2 전송 및 응답 대기
                    new Promise((resolveChannel) => {
                        const userId = parseInt(joinedData[0].userinfo_userId)+ 3;
                        const query = `UPDATE emo_user_info 
                        SET erkEmoSrvcStart_send_dt = NOW(3)
                        WHERE userinfo_userId = ${userId}`;

                        // 실행되는 쿼리 확인
                        logger.info(`[ audioServices.js:EmoServiceStartRQ ] Executing query: ${query}`);

                        connection1.query(query, (error, results) => {
                            if (error) { reject(error); }        
                            resolveChannel(results);
                        });

                        // 메시지 전송
                        logger.info(`[ audioServices.js:EmoServiceStartRQ ] cus 업데이트 후 메세지 송신\n${JSON.stringify(EmoServiceStartMsg_cus, null, 4)}`);
                        ch2.sendToQueue("ERK_API_QUEUE", EmoServiceStartMsg_buf_cus);
                    })
                ];

                // 메시지 전송 완료 대기
                const channelResults = await Promise.all(channelPromises);

                // EmoServiceStartRP에서 DB 업데이트할 때까지 대기
                const checkQueueInterval = setInterval(async () => {
                    try {
                        // 상담원/고객 큐 정보 설정 여부 확인
                        const [queueStatus] = await new Promise((resolveQuery, rejectQuery) => {
                            connection1.query(`SELECT COUNT(*) as count
                                FROM emo_user_info 
                                WHERE (
                                    (userinfo_userId = ? AND erkengineInfo_return_recvQueueName IS NOT NULL)
                                    OR
                                    (userinfo_userId = ? AND erkengineInfo_returnCustomer_recvQueueName IS NOT NULL)
                                )`,
                                [
                                    parseInt(joinedData[0].userinfo_userId), 
                                    parseInt(joinedData[0].userinfo_userId)+ 3
                                ],
                                (error, results) => {
                                    if (error) {
                                        logger.error(`Queue check query error: ${error.message}`);
                                        rejectQuery(error);
                                    }

                                    // logger.debug(`Queue check results: ${JSON.stringify(results)}`);
                                    resolveQuery(results);
                                }
                            );
                        });

                        // 두 채널 모두 큐 정보 설정 완료 확인
                        if (queueStatus && queueStatus.count === 2) {
                            logger.info(`[ audioServices.js:EmoServiceStartRQ ] 상담원/고객 채널 큐 정보 확인`);
                            
                            clearInterval(checkQueueInterval);
                            resolve(channelResults);
                        }
                    } catch (error) {
                        clearInterval(checkQueueInterval);
                        reject(error);
                    }
                }, 100);

                // 타임아웃 설정(10초)
                setTimeout(() => {
                    clearInterval(checkQueueInterval);
                    logger.info(`[ audioServices.js:EmoServiceStartRQ ] Queue setup timeout`);

                    resolve([null, null]);
                }, 10000);
            });
        }

        const response = await sendAndWaitForResponse();
        if (!response || !Array.isArray(response) || response.some(r => !r)) {
            logger.warn(`[ audioServices.js:EmoServiceStartRQ ] Invalid response: ${JSON.stringify(response, null, 2)}`);

            return {
                message: 'error',
                return_type: 0,
                error: 'Invalid response from sendAndWaitForResponse'
            };
        }

        logger.info(`[ audioServices.js:EmoServiceStartRQ ] 유효한 응답: ${JSON.stringify(response, null, 2)}`);

        return {
            message: 'success',
            return_type: 1,
            userinfo_userId: joinedData[0].userinfo_userId,
            login_id: joinedData[0].login_id,
            org_id: parseInt(joinedData[0].user_orgid),
            user_uuid: joinedData[0].user_uuid
        };
    } catch(err) {
        logger.error(`[ audioServices.js:EmoServiceStartRQ ] ${err}`);
    }
}

//  GSM 파일 무결성 체크
async function checkGsm610WavFileIntegrity(filePath) {
    let fd;
    try {
        // 버퍼 생성 전 null/undefined 체크
        const headerBuffer = Buffer.alloc(44);
        const chunkBuffer = Buffer.alloc(8);

        // Buffer가 제대로 생성되었는지 확인
        fd = await fsp.open(filePath, 'r');

        // WAVE 헤더 검증
        const { bytesRead } = await fd.read(headerBuffer, 0, 44, 0);
        if (bytesRead !== 44) {
            throw new Error(`Failed to read header: only ${bytesRead} bytes read`);
        }
        
        // RIFF 검증
        const riffHeader = headerBuffer.slice(0, 4).toString('ascii');
        if (riffHeader !== 'RIFF') {
            throw new Error(`Invalid RIFF header: ${riffHeader}`);
        }
        
        // 파일 크기 검증 추가
        const fileSize = headerBuffer.readUInt32LE(4);
        if (fileSize <= 44) {
            throw new Error(`Invalid file size: ${fileSize}`);
        }
        
        // WAVE 포맷 검증
        const waveFormat = headerBuffer.slice(8, 12).toString('ascii');
        if (waveFormat !== 'WAVE') {
            throw new Error(`Invalid WAVE format: ${waveFormat}`);
        }
        
        // fmt 청크 검증
        const fmtChunk = headerBuffer.slice(12, 16).toString('ascii');
        if (fmtChunk !== 'fmt ') {
            throw new Error(`Invalid fmt chunk: ${fmtChunk}`);
        }
        
        // fmt 청크 크기 검증
        const fmtChunkSize = headerBuffer.readUInt32LE(16);
        if (isNaN(fmtChunkSize) || fmtChunkSize < 16) {
            throw new Error(`Invalid fmt chunk size: ${fmtChunkSize}`);
        }
        
        // GSM 6.10 포맷 검증
        const audioFormat = headerBuffer.readUInt16LE(20);
        if (audioFormat === 0x0031) {
            // 데이터 청크 찾기 및 검증
            let offset = 12 + fmtChunkSize + 8;
            let foundData = false;
            let headerLength = 0;
        
            while (offset < (await fd.stat()).size) {
                const chunkReadResult = await fd.read(chunkBuffer, 0, 8, offset);
                if (chunkReadResult.bytesRead !== 8) break;
                
                const chunkId = chunkBuffer.slice(0, 4).toString('ascii');
                const chunkSize = chunkBuffer.readUInt32LE(4);
                
                if (chunkId === 'data') {
                    // GSM 6.10 프레임 크기 검증
                    if (chunkSize % 65 !== 0) {
                        throw new Error(`Invalid data chunk size for GSM 6.10: ${chunkSize}`);
                    }
                    foundData = true;
                    headerLength = offset + 8;
                    break;
                }
                offset += 8 + chunkSize;
            }

            if (!foundData) { throw new Error('Data chunk not found'); }

            return {
                status: "valid",
                format: "GSM 6.10",
                audioFormat: "0x0031",
                gsmHeaderLength: headerLength,  // 헤더 전체 길이 반환
                dataOffset: headerLength     // 데이터 시작 위치도 함께 반환
            };
        } else if (audioFormat === 0x0001) { // 이미 PCM 포맷인 경우
            // 데이터 청크 찾기
            let offset = 12 + fmtChunkSize + 8;
            let foundData = false;
            let headerLength = 0;

            while (offset < (await fd.stat()).size) {
            const chunkReadResult = await fd.read(chunkBuffer, 0, 8, offset);
            if (chunkReadResult.bytesRead !== 8) break;

            const chunkId = chunkBuffer.slice(0, 4).toString('ascii');
            const chunkSize = chunkBuffer.readUInt32LE(4);

            if (chunkId === 'data') {
                foundData = true;
                headerLength = offset + 8;
                break;
            }
            offset += 8 + chunkSize;
            }

            if (!foundData) {
            throw new Error('Data chunk not found');
            }

            return {
                status: "valid",
                format: "PCM",
                audioFormat: "0x1",
                gsmHeaderLength: headerLength,
                dataOffset: headerLength
            };
        } else {
            throw new Error(`Unsupported audio format: 0x${audioFormat.toString(16)}`);
        }
    } catch (error) {
        throw new Error(error.message);
    } finally {
        if (fd) await fd.close();  // 파일 디스크립터 닫기 필수
    }
}

module.exports = {
    handleNewFile,
    EmoServiceStartRQ
};