'use strict'
//  마운트된 디렉토리의 파일 생성/변경을 감지하고 이벤트를 발생시키는 파일 시스템 와처

const AudioFileManager = require('./AudioFileManager');
const { handleNewFile, EmoServiceStartRQ } = require('../services/audioServices');

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
                        logger.warn(`[ EnhancedFSWatcher.js:watchFileAdd ] ${validationResult.reason} for ${filePath}`);
                        return;
                    }


                    // 2. rx 또는 tx 파일은 Skip (통합본의 파일명으로 이미 처리됨)
                    const fileName = path.basename(filePath);
                    if (fileName.includes('_rx') || fileName.includes('_tx')) {
                        return; 
                    }


                    //  3. 통합본 파일에 대해 EmoServiceStartRQ 수행 
                    const serviceResponse = await EmoServiceStartRQ(fileName);
                    if (!serviceResponse) {
                        logger.warn(`[ watchFileAdd ] No response from EmoServiceStartRQ for ${fileName}`);
                        return;
                    }
                    logger.info(`[ watchFileAdd:EmoServiceStartRQ ] Received response for ${fileName} (Response: ${serviceResponse.return_type} - ${serviceResponse.message})`);
                    
                    //   - 3.1. 응답 검증: 더 엄격한 체크
                    if (serviceResponse.return_type === 1) {
                        logger.info(`[ watchFileAdd:EmoServiceStartRQ ] 성공적인 응답 수신: ${JSON.stringify(serviceResponse, null, 2)}`);
                        //   - rx/tx 파일명 생성
                        const baseFileName = path.basename(fileName, '.wav');
                        const fileTypes = ['rx', 'tx'];

                        //   - 병렬 처리
                        const results = await Promise.all(fileTypes.map(async (type) => {
                            logger.warn(`[ EnhancedFSWatcher.js:setupEventHandlers ] baseFileName : ${baseFileName}`);
                            logger.warn(`[ EnhancedFSWatcher.js:setupEventHandlers ] type : ${type}`);
                            const typedFileName = `${baseFileName}_${type}.wav`;
                            const typedFilePath = path.join(path.dirname(filePath), typedFileName);
                            
                            try {
                                // 유효성 검사
                                if (!serviceResponse.userinfo_userId) {
                                    throw new Error('userinfo_userId is undefined in serviceResponse');
                                }

                                // serviceResponse 전체와 fileType을 전달하여 파일 처리
                                logger.warn(`[ watchFileAdd:EmoServiceStartRQ ] serviceResponse.userinfo_userId : ${serviceResponse.userinfo_userId}`);
                                logger.warn(`[ watchFileAdd:EmoServiceStartRQ ] typedFileName : ${typedFileName}`);
                                logger.warn(`[ watchFileAdd:EmoServiceStartRQ ] typedFilePath : ${typedFilePath}`);

                                const result = await handleNewFile(
                                    typedFilePath, 
                                    serviceResponse.userinfo_userId, // userinfo_userId 접근
                                    serviceResponse, // EmoServiceStartRQ 전체 응답 전달
                                    type // 파일 유형 전달
                                );
                                logger.info(`[ watchFileAdd:handleNewFile ] ${type} 처리 완료:`, result);

                                return { type, success: true, result };
                            } catch (error) {
                                logger.error(`[ watchFileAdd:handleNewFile ] ${type} 처리 실패:`, error);
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
        
        // 파일명 패턴 검증 (파일명만 체크하도록 수정)
        const filePattern = /^\d{17}_[A-Z]_\d+\.wav$/;
        // rx/tx 파일명 패턴 ( 얘는 테스트가 끝날시 지워도 됨 20250120 )
        const splitPattern = /^\d{17}_[A-Z]_\d+_(rx|tx)\.wav$/;

        if (!filePattern.test(fileName) && !splitPattern.test(fileName)) { 
            logger.error(`Invalid filename format: ${fileName}`);
            return { isValid: false, reason: 'invalid_filename_format' }; 
        }

        const fileKey = fileName; // fileKey 정의 추가

        // 이미 처리 중인 파일 체크
        if (this.activeFiles.has(fileKey)) {
            const lastEvent = this.activeFiles.get(fileKey);
            if (currentTime - lastEvent.time < this.config.stabilityThreshold) {
                return { isValid: false, reason: 'duplicate' };
            }
        }

        // WAV 파일 검증
        if (!fileName.toLowerCase().endsWith('.wav')) {
            return { isValid: false, reason: 'not_wav_file' };
        }

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