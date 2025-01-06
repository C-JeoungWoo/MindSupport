# README

## 작업 시 주의사항
현재 작업이 개별 서버에서 이루어지고 있으므로, `git pull`을 이용해 작업을 진행할 때 반드시 **작업하는 서버의 IP**로 변경해야 합니다.

### IP 수정이 필요한 파일 목록
아래는 IP 수정이 필요한 파일들과 변경 위치를 정리한 표입니다:

| 파일 이름          | 변경 위치 (설명)                                           | 예시 코드                     |
|--------------------|------------------------------------------------------------|-------------------------------|
| **db/acrV4.js**    | 해당 호스트 뿐만아니라 port, user, password 변경                   | `host: '192.168.x.x'`         |
| **db/maria.js**    | 해당 호스트 뿐만아니라 port, user, password 변경                        | `host: '192.168.x.x'`         |
| **app.js**         | MySQLoptions 부분 IP 및 port, user, password 변경                 | `host: 'http://192.168.x.x'` |
| **consultant.ejs** | 소켓 연결하는 부분 IP 변경                  | `url: 'http://192.168.x.x'`   |
| **index.ejs**      | 소켓 연결하는 부분 IP 변경      | `url: 'http://192.168.x.x'`   |
|      | **nfs-server systemctl status 확인**      |   |
|      | **nfs-client 마운트 상태 확인**      |  |
|       | **DB 쿼리 코드에 들어있는 DB명 전부를 ETRI_EMOTION => MindSupport로 변경**       |    |
|       | **load.proto() 경로 변경**       |    |
|       | **config 디렉토리 내부의 directories.js 경로 변경**       |    |

### 작업 순서
1. `git pull` 명령어를 사용하여 최신 코드를 가져옵니다.
2. 위의 표를 참고하여 **작업하는 서버의 IP 주소**로 파일 내 IP를 수정합니다.
3. 변경 사항을 저장한 후 프로젝트를 실행하여 올바르게 동작하는지 확인합니다.

### 참고
- IP 주소 변경 후 프로젝트를 실행하기 전, 수정한 파일을 다시 한번 확인하세요.
- 서버 간 IP 주소 혼동으로 인한 오류를 방지하기 위해, 각 서버에 고유한 환경설정을 유지하세요.

GIT 사용시 꿀팁
git pull 은 git fetch + git merge 작업을 합쳐서 한번에 병행하는 작업으로
코드 충돌시 에러가 나는 경우가 많다. 이를 안전하게 수행하기 위해선
git pull 대신 git merge로 먼저 파일 충돌을 resolve 해준 후 git commit을 실시하고
그 후 git push 할 경우 순조롭게 GitHub push가 가능하다.
