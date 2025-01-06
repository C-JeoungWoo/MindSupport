'use strict'

// 음성파일 처리 관련 디렉토리 설정
const DIRECTORIES = {
    NFS_MOUNT: '/home/241212_MindSupport/MindSupport/ms_nfs_mount',          // NFS 마운트 포인트
    TEMP_GSM: '/home/241212_MindSupport/MindSupport/ms_temp_gsm_files',      // GSM 청크 임시 저장
    PCM_OUTPUT: '/home/241212_MindSupport/MindSupport/ms_pcm_files',         // PCM 변환 결과
    LOGS: '/home/241212_MindSupport/MindSupport/logs/ms_audio_log'           // 로그 파일
};

module.exports = DIRECTORIES;