룰렛업보정리기 v5.8 → 배포된 업보 페이지 연동
===============================================

이 폴더는 룰렛업보정리기가 만든 정규화 업보 기록만 사이트의
https://<사이트주소>/api/weplab/import 로 보내는 브리지입니다.
위플랩 로그인 쿠키, 비밀번호, loginData는 전송하지 않습니다.

C# 소스(WeflabSiteBridge.cs)와 패치는 예전과 똑같습니다.
바뀐 건 doomi-site-bridge.json의 siteUrl과 token 값뿐입니다.


적용 순서
---------
1. 상위 폴더 README.md의 배포를 먼저 끝냅니다.
   (Cloudflare Pages 환경 변수 DOOMI_BRIDGE_TOKEN까지 넣어야 합니다.)

2. WeflabSiteBridge.cs를 룰렛업보정리기 소스의 desktop 폴더에 복사합니다.

3. 룰렛업보정리기 소스 루트에서 v5.8-integration.patch를 적용합니다.

4. doomi-site-bridge.local.json을 아래 위치에 복사하고 파일명을
   doomi-site-bridge.json으로 바꿉니다.

   %APPDATA%\RouletteKarma\doomi-site-bridge.json

   siteUrl : Cloudflare Pages 주소. 예) https://doomi-upbo.pages.dev
             주소 끝에 /를 붙이지 않아도 되고, 경로도 붙이지 않습니다.
             브리지가 /api/weplab/import를 알아서 붙입니다.

             ⚠ https:// 를 반드시 포함하세요.
               doomi-upbo.pages.dev  (X) 주소 형식 오류로 전송 안 함
               https://doomi-upbo.pages.dev  (O)

             ⚠ 최종 주소를 넣으세요. 브리지는 토큰이 새는 것을 막으려고
               리다이렉트를 따라가지 않습니다. www 를 붙이면 apex 로
               넘기는 커스텀 도메인 같은 곳을 적으면 전송이 실패합니다.
               실제로 페이지가 열리는 그 주소를 그대로 넣으면 됩니다.

   token   : Cloudflare Pages 환경 변수 DOOMI_BRIDGE_TOKEN과 같은 값.
             두 값이 다르면 서버가 401로 거절합니다.

5. desktop\build.bat으로 다시 빌드한 뒤 프로그램을 재실행합니다.


동작 방식
---------
- 룰렛 결과의 event_uid + stage를 중복 방지 키로 씁니다.
- 이미 저장된 기록은 다시 덮어쓰지 않습니다. 관리자 페이지에서 완료로
  바꾼 기록이 재전송 때문에 진행 중으로 되돌아가지 않습니다.
- 전송 전 outbox 파일에 보관하므로 인터넷이 잠깐 끊겨도 다음에 재시도합니다.
- 서버가 400/409/413/422로 거절한 묶음은 rejected 파일에 보관됩니다.
  %APPDATA%\RouletteKarma\doomi-site-bridge.rejected.ndjson
- 공개 페이지는 30초마다 새 기록을 확인합니다.


토큰 관리
---------
token은 이 사이트에 기록을 넣을 수 있는 유일한 열쇠입니다.
- 32자 이상의 임의 문자열로 만드세요.
- 다른 사람에게 공유하지 마세요.
- 노출된 것 같으면 Cloudflare 환경 변수와 이 파일의 값을 동시에 바꾸면 됩니다.

siteUrl은 https만 허용됩니다. http로 적으면 브리지가 토큰 보호를 위해
전송을 거부합니다.


연결 확인
---------
룰렛업보정리기 상태 표시줄에 "두미 브리지:" 로 시작하는 메시지가 나옵니다.
  전송 완료 N건        정상
  전송 실패 HTTP 401   token 불일치
  전송 실패 HTTP 503   Cloudflare 환경 변수 누락
  비활성 · ...         doomi-site-bridge.json 설정 문제

원본 프로그램은 이 폴더를 여는 것만으로는 바뀌지 않습니다.
2~5단계를 직접 적용했을 때만 브리지가 추가됩니다.


첫 연결 때 확인할 것
-------------------
서버 쪽(수신 API)은 토큰 검증·중복 제거·형식 검사까지 전부 시험을 마쳤지만,
룰렛업보정리기를 실제로 빌드해서 붙여보는 것은 윈도우에서만 할 수 있습니다.
그래서 처음 연결할 때 아래 두 가지를 눈으로 확인해 주세요.

1. 룰렛을 한 번 돌린 뒤 상태 표시줄에 "두미 브리지: 전송 완료 1건" 이 뜨는지
2. 공개 페이지를 새로고침했을 때 그 기록이 닉네임·업보 내용까지 제대로 뜨는지

2번에서 닉네임이 "익명", 아이디가 "unknown" 으로 뜨면 수집기가 보내는
항목 이름이 예상과 다른 경우입니다. 그럴 때 rejected 파일이나 전송 실패
메시지를 알려주시면 받는 쪽을 맞추면 됩니다.
