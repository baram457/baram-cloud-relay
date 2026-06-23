바람 V10.71 클라우드 중계 설치 순서

중요:
- 이제 바람 PC를 24시간 켜둘 필요가 없습니다.
- 단, 클라우드 서버는 Render/Railway 같은 곳에 한 번 올려야 합니다.
- 제가 바람 계정에 직접 배포할 권한은 없어서, 올릴 파일을 완성해둔 상태입니다.

폴더 설명:
1) baram_cloud_relay_server
   - 클라우드에 올릴 서버 폴더입니다.
   - 안에 server.js, package.json, render.yaml 이 있습니다.

2) 바람_화면.html
   - 바람이 실행하는 화면 파일입니다.
   - 화면 위의 [서버주소] 버튼에 클라우드 주소를 한 번만 저장하면 됩니다.

Render에 올리는 순서:
1. GitHub에 baram_cloud_relay_server 폴더를 새 저장소로 올립니다.
2. Render에서 New Web Service 선택합니다.
3. GitHub 저장소 연결합니다.
4. Build Command: npm install
5. Start Command: npm start
6. 배포가 끝나면 주소가 나옵니다.
   예: https://baram-cloud-relay.onrender.com
7. 바람_화면.html 열기
8. [서버주소] 버튼 클릭
9. 아래 형식으로 입력
   wss://baram-cloud-relay.onrender.com/ws
10. 종목 선택

동작 구조:
바람_화면.html
  ↓ WebSocket
클라우드 중계 서버
  ↓
BTC = Binance
나스닥/금/은/오일/항셍 = Yahoo 중계

주의:
- 무료 클라우드는 잠자기/재시작이 있을 수 있습니다.
- 모투 테스트용으로는 충분하지만 실투용 시세 보장은 아닙니다.
- 가짜 캔들은 만들지 않습니다. 수신 실패 시 오류/수신대기로 표시합니다.
