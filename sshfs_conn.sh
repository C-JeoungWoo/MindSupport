# !/bin/bash
#   SSH 키 쌍 생성
#    - ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa
#    - 공개/개인 키 쌍을 생성
#   원격 서버에 공개키 복사
#    - ssh-copy-id -i ~/.ssh/id_rsa.pub USERNAME@REMOTE_SERVER
#   SSH 연결 테스트
#    - ssh -i ~/.ssh/id_rsa USERNAME@REMOTE_SERVER -p 2288
#   스크립트작성
#    - 원격 SSHFS 서버 정보
REMOTE_SERVER='211.41.186.209'
REMOTE_DIRECTORY='/home/test/acr_docker/workspace/data/recdata/'
USERNAME='test'

#    - 로컬 SSHFS 클라이언트 서버 마운트 디렉토리 경로
MOUNT_POINT='./1_records/'

#    - SSHFS 마운트 옵션 설정
SSHFS_OPTIONS="-o IdentityFile=/home/test/.ssh/id_rsa -p 2288"

#    - SSHFS 마운트 (키 파일 사용)
sshfs $SSHFS_OPTIONS $USERNAME@$REMOTE_SERVER:$REMOTE_DIRECTORY $MOUNT_POINT