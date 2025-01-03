'use strict'
//  마운트된 디렉토리의 파일 생성/변경을 감지하고 이벤트를 발생시키는 파일 시스템 와처

const AudioFileManager = require('./AudioFileManager');
const { handleNewFile, EmoServiceStartRQ, EmoServiceStopRQ } = require('../services/audioServices');

const DIRECTORIES = require('../config/directories');
const logger = require('../logs/logger');
const fs = require('fs');
const fsp = require('fs').promises;
const chokidar = require(`chokidar`);
const path = require(`path`);

const { getErkApiMsg } = require('../utils/erkUtils');

//  Watcher 최적화 클래스
class EnhancedFSWatcher {
    constructor(config = {}) {
        this.config = {
            basePath: DIRECTORIES.NFS_MOUNT,
            pollingInterval: config.pollingInterval || 50,  // chokidar watching 용
            useParallelProcessing: config.useParallelProcessing || true  // 병렬 처리 옵션 유지
        };
    
        this.watcher = null;
        this.activeFiles = new Map();
        this.audioFileManager = new AudioFileManager(); // 기존 AudioFileManager 연동
    }

    //  디렉토리 유무 파악
    async validateDirectories() {
        for (const [key, dir] of Object.entries(DIRECTORIES)) {
            if (!fs.existsSync(dir)) {
                await fsp.mkdir(dir, { recursive: true });
                logger.info(`[ EnhancedFSWatcher:validateDirectories ] Created directory: ${dir}`);
            }
        }
    }

    //  Watcher 초기화
    async initializeWatcher() {
        try {
            // 디렉토리 초기화 확인
            await this.validateDirectories();

            this.watcher = chokidar.watch(this.config.basePath, {
                persistent: true,
                ignoreInitial: true,
                usePolling: true,
                interval: this.config.pollingInterval,
                awaitWriteFinish: {
                    stabilityThreshold: this.config.stabilityThreshold,
                    pollInterval: Math.floor(this.config.pollingInterval / 2)
                },
                atomic: true,
                alwaysStat: true,
                ignored: '*.txt'
            });

            //  파일 이벤트 핸들러
            this.setupEventHandlers();
            logger.info('[ EnhancedFSWatcher:initializeWatcher ] File system watcher initialized successfully');
            
            return this.watcher;
        } catch (error) {
            logger.error(`[ EnhancedFSWatcher:initializeWatcher ] Initialization error: ${error}`);
            throw error;
        }
    }

    //  파일 이벤트 핸들러
    setupEventHandlers() {
        this.watcher
            .on('ready', () => { logger.info('[ EnhancedFSWatcher.js:watchDirectoryReady ] Initial scan complete. Ready for changes...'); })
            .on('addDir', async(filePath) => logger.info(`[ EnhancedFSWatcher.js:watchDirectoryAdd ] Directory ${filePath} has been added.`))
            .on('add', async (filePath) => {
                logger.info(`[ EnhancedFSWatcher.js:watchFileAdd ] File ${filePath} has been added`);
    
                try {
                    // 1. validateFileEvent를 통한 파일 검증
                    const validationResult = await this.validateFileEvent(filePath);
                    if (!validationResult.isValid) {
                        logger.warn(`[ EnhancedFSWatcher.js:watchFileAdd ] File validation failed: ${validationResult.reason} for ${filePath}`);
                        return;
                    }

                    const fileName = path.basename(filePath);
                    // 2. rx 또는 tx 파일은 Skip (통합본의 파일명으로 이미 처리됨)
                    if (fileName.includes('_rx') || fileName.includes('_tx')) { return; }

                    //  3. 통합본 파일에 대해 EmoServiceStartRQ 수행 
                    const serviceResponse = await EmoServiceStartRQ(fileName);
                    // response가 제대로 있는지 확인
                    if (!serviceResponse) {
                        logger.warn(`[ watchFileAdd ] No response from EmoServiceStartRQ for ${fileName}`);
                        return;
                    }

                    logger.info(`[ watchFileAdd:EmoServiceStartRQ ] Received response for ${fileName} (Response: ${serviceResponse.return_type} - ${serviceResponse.message})`);
                    
                    //   - 응답 검증: 더 엄격한 체크
                    if (serviceResponse.return_type === 1) {
                        logger.info(`[ watchFileAdd:EmoServiceStartRQ ] 성공적인 응답 수신: ${JSON.stringify(serviceResponse, null, 2)}`);

                        //   - rx/tx 파일명 생성
                        const baseFileName = path.basename(fileName, '.wav');
                        const fileTypes = ['rx', 'tx'];

                        //   - 병렬 처리로 성능 개선
                        const results = await Promise.all(fileTypes.map(async (type) => {
                            const typedFileName = `${baseFileName}_${type}.wav`;
                            const typedFilePath = path.join(path.dirname(filePath), typedFileName);
                            
                            try {
                                // serviceResponse 전체와 fileType을 전달하여 파일 처리
                                const result = await handleNewFile(
                                    typedFilePath, 
                                    serviceResponse.userinfo_userId, // userinfo_userId 접근 수정
                                    serviceResponse, // 전체 응답 전달
                                    type // 파일 유형 전달
                                );
                                logger.info(`[ watchFileAdd:handleNewFile ] ${type.toUpperCase()} 처리 완료:`, result);

                                return { type, success: true, result };
                            } catch (error) {
                                logger.error(`[ watchFileAdd:handleNewFile ] ${type.toUpperCase()} 처리 실패:`, error);
                                return { type, success: false, error };
                            }
                        }));

                        // 4. 결과 검증
                        const failures = results.filter(r => !r.success);
                        if (failures.length > 0) { logger.error(`[ watchFileAdd:handleNewFile ] Failed to process: ${failures.map(f => f.type).join(', ')}`); }

                        return results;
                    } else {
                        logger.error(`[ watchFileAdd:EmoServiceStartRQ ] 실패 응답: ${serviceResponse.error}`);
                    }
                } catch (error) {
                    logger.error(`[ watchFileAdd:EmoServiceStartRQ ] Error processing file ${filePath}:`, error);

                    // if (error.message.includes('Invalid response') || error.message.includes('Queue setup timeout')) {
                    //     logger.warn(`[ watchFileAdd ] Will retry processing later`);
                    //     // 나중에 재시도 로직 추가 가능
                    // }
                    
                    // 에러가 발생해도 프로세스는 중단하지 않음
                    return;
                }
            })
            .on('error', error => logger.error(`[ EnhancedFSWatcher.js:watchDirectoryError ] ${error}`))
            .on('change', path => logger.info(`[ EnhancedFSWatcher.js:watchDirectoryChange ] File ${path} has been changed`))
            .on('unlink', path => logger.info(`[ EnhancedFSWatcher.js:watchDirectoryUnlink ] File ${path} has been removed`));
    }

    //  파일 검증 이벤트
    async validateFileEvent(filePath) {
        const fileName = path.basename(filePath);
        const currentTime = Date.now();
        
        // 파일명 패턴 검증 추가 필요
        const filePattern = /^\d{17}_[A-Z]_\d+\.wav$/;
        if (!filePattern.test(fileName)) { return { isValid: false, reason: 'invalid_filename_format' }; }

        const fileKey = fileName; // fileKey 정의 추가

        // 이미 처리 중인 파일 체크
        if (this.activeFiles.has(fileKey)) {
            const lastEvent = this.activeFiles.get(fileKey);
            if (currentTime - lastEvent.time < this.config.stabilityThreshold) {
                return { isValid: false, reason: 'duplicate' };
            }
        }

        // WAV 파일 검증
        if (!fileName.toLowerCase().endsWith('.wav')) { return { isValid: false, reason: 'not_wav_file' }; }

        try {
            const stats = await fsp.stat(filePath);

            return {
                isValid: true,
                stats,
                time: currentTime
            };
        } catch (error) {
            logger.error(`[ app.js:EnhancedFSWatcher ] File validation error: ${error}`);
            return { isValid: false, reason: 'validation_error' };
        }
    }

    async handleFileAddition(filePath, fileInfo) {
        const fileName = path.basename(filePath);
        const fileKey = fileName;

        // getErkApiMsg()의 반환값 구조 분해
        const { ErkApiMsg, ch, ch2, ErkQueueInfo, ErkQueueInfo2 } = getErkApiMsg();

        try {
            // 파일 상태 추적 시작
            this.activeFiles.set(fileKey, {
                time: Date.now(),
                size: fileInfo.stats.size,
                status: 'monitoring',
                path: filePath
            });

            // 파일명 형식 검증 (20230823142311200_A_2501.wav)
            const filePattern = /^\d{17}_[A-Z]_\d+\.wav$/;
            if (!filePattern.test(fileName)) {
                logger.error(`[ EnhancedFSWatcher:handleFileAddition ] Invalid filename format: ${fileName}`);
                return;
            }

            // AudioFileManager를 통한 파일 처리
            const { ready, files } = await this.audioFileManager.trackFile(filePath);
            
            if (ready) {
                const callId = fileName.replace(/(_rx|_tx)?\.wav$/, '');
                logger.info(`[ app.js:watchFileAdd ] Starting parallel processing for call ${callId}`);
    
                try {
                    // EmoServiceStartRQ 호출
                    const serviceResponse = await EmoServiceStartRQ(filePath);
    
                    if (serviceResponse.return_type === 1 || serviceResponse.message === "success") {
                        // 병렬 처리 시작
                        const results = await this.audioFileManager.processChannelFiles(callId, files);
    
                        // 처리 결과 확인
                        const success = results.every(r => r.success);
                        if (success) {
                            logger.info(`[ app.js:watchFileAdd ] Successfully processed all channels for ${callId}`);
                            await this.handleProcessingCompletion(callId, results);
                            this.metrics.successfulEvents++;
                        } else {
                            logger.error(`[ app.js:watchFileAdd ] Some channels failed processing for ${callId}`, results);
                            await this.handleProcessingError(callId, results);
                            this.metrics.missedEvents++;
                        }
                    } else {
                        logger.error(`[ app.js:watchFileAdd ] EmoServiceStartRQ failed for ${callId}: ${serviceResponse.message}`);
                        await this.handleProcessingError(callId, { error: 'EmoService start failed' });
                        this.metrics.missedEvents++;
                    }
                } catch (error) {
                    logger.error(`[ app.js:watchFileAdd ] Error in processing file ${filePath}:`, error);
                    await this.handleProcessingError(callId, { error: error.message });
                    this.metrics.missedEvents++;
                }
            }
        } catch (error) {
            logger.error(`[ app.js:EnhancedFSWatcher ] Error in file addition handler: ${error}`);
            this.metrics.missedEvents++;
        }
    }

    async handleFileProcessing(filePath, fileName, serviceResponse) {
        try {
            // rx, tx 파일명 생성
            const baseFileName = path.basename(fileName, '.wav');
            const rxFileName = `${baseFileName}_rx.wav`;
            const txFileName = `${baseFileName}_tx.wav`;
    
            // rx, tx 파일 경로
            const rxFilePath = path.join(path.dirname(filePath), rxFileName);
            const txFilePath = path.join(path.dirname(filePath), txFileName);
    
            try {
                // rx 파일 처리
                // const rxResult = await handleNewFile(rxFilePath, serviceResponse.userinfo_userId, { fileType: 'rx' });
                const rxResult = await handleNewFile(rxFilePath, serviceResponse.userinfo_userId, serviceResponse, 'rx');
                logger.warn(`[ app.js:handleNewFileResult ] ${rxFileName} RX 처리 완료 ${rxResult}`);
    
                // tx 파일 처리
                // const txResult = await handleNewFile(txFilePath, serviceResponse.userinfo_userId, { fileType: 'tx' });
                const txResult = await handleNewFile(txFilePath, serviceResponse.userinfo_userId, serviceResponse, 'tx');
                logger.warn(`[ app.js:handleNewFileResult ] ${txFileName} TX 처리 완료 ${txResult}`);
    
            } catch (processError) {
                logger.error(`[ app.js:watchFileAdd ] Error processing rx/tx files: ${processError}`);
                throw processError;  // 상위로 에러 전파
            }
        } catch (error) {
            logger.error(`[ app.js:handleFileProcessing ] Error: ${error}`);
        }
    }

    // 처리 완료 후 정리 함수
    async handleProcessingCompletion(callId, results) {
        try {
            // 사용자 정보 가져오기
            const userId = await this.getUserIdFromCallId(callId);
            
            // EmoServiceStopRQ 호출
            const stopResult = await EmoServiceStopRQ(userId);
            if (stopResult === 'success') {
                logger.info(`[ app.js:handleProcessingCompletion ] EmoService stopped successfully for ${callId}`);

                // 파일 상태 업데이트
                if (this.activeFiles.has(callId)) {
                    this.activeFiles.get(callId).status = 'completed';
                }
            } else {
                logger.error(`[ app.js:handleProcessingCompletion ] Failed to stop EmoService for ${callId}`);
            }
        } catch (error) {
            logger.error(`[ app.js:handleProcessingCompletion ] Error in completion handling for ${callId}:`, error);
            throw error;
        }
    }

    // 에러 처리 함수
    async handleProcessingError(callId, error) {
        try {
            logger.error(`[ app.js:handleProcessingError ] Processing error for ${callId}:`, error);
            
            // 파일 상태 업데이트
            const fileInfo = this.activeFiles.get(callId);
            if (fileInfo) {
                fileInfo.status = 'error';
                fileInfo.error = error;
            }

            // 필요한 경우 cleanup 수행
            try {
                const userId = await this.getUserIdFromCallId(callId);
                await EmoServiceStopRQ(userId);
            } catch (cleanupError) {
                logger.error(`[ app.js:handleProcessingError ] Cleanup error for ${callId}:`, cleanupError);
            }

        } catch (error) {
            logger.error(`[ app.js:handleProcessingError ] Error handling failure for ${callId}:`, error);
        }
    }

    cleanup() {
        for (const [fileKey, fileInfo] of this.activeFiles) {
            if (fileInfo.monitorInterval) {
                clearInterval(fileInfo.monitorInterval);
            }
        }
        
        this.activeFiles.clear();

        if (this.watcher) {
            this.watcher.close();
        }

        logger.info('[ app.js:EnhancedFSWatcher ] Cleanup completed');
    }
}

module.exports = EnhancedFSWatcher;