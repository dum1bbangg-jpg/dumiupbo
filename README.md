# 두미의 업보 수첩 — 배포판

인터넷에 올려서 누구나 볼 수 있는 업보 페이지입니다.
기록은 Supabase에 저장되고, 화면은 Cloudflare Pages에 올라갑니다.

| 파일 | 하는 일 |
|---|---|
| `index.html` | 공개 업보 목록. 검색·상태·정렬·통계·상세 |
| `admin/index.html` | 관리자. 로그인 후 등록·수정·삭제·완료 처리 |
| `config.js` | **여기 두 줄만 직접 채웁니다** (Supabase 주소·anon 키) |
| `db.js` | Supabase 연결과 데이터 처리 |
| `public.js` | 공개 페이지 동작 (기록·통계·도감·캘린더) |
| `admin/admin.js` | 관리자 동작 |
| `styles.css` | 전체 디자인 |
| `functions/api/weplab/import.js` | 룰렛업보정리기가 보낸 기록을 받는 API |
| `supabase.sql` | 표 생성과 접근 권한. SQL Editor에서 한 번 실행 |
| `pcview.js` | 숲 앱에서 `PC 화면 ↗` 을 눌렀을 때 PC 배치로 여는 스크립트 |
| `_headers` | Cloudflare 보안 헤더 |
| `weflab-bridge/` | 룰렛업보정리기 연동용 소스와 안내 |

---

## 공개 페이지 메뉴 4가지

| 메뉴 | 내용 |
|---|---|
| 업보 기록 | 표/카드 목록. 검색·상태·정렬, 클릭하면 상세 |
| 통계 | 진행률, 최근 14일 추가 추이, 업보왕 TOP 5, 많이 걸린 업보 TOP 5 |
| 업보 도감 | 두콩이별 카드. 프사(SOOP)·업보 총합, 클릭하면 업보 종류별 횟수 |
| 업보 캘린더 | 월별 달력. 날짜를 누르면 그날 기록만 |

분류는 룰렛 벌칙 · 약속 · 이벤트 세 가지입니다. 룰렛에서 자동으로 들어온 기록은
전부 룰렛 벌칙으로 저장되고, 관리자에서 바꿀 수 있습니다.
분류 이름을 고치려면 `supabase.sql` 의 `debts_category_check` 와 `db.js` 의
`CATEGORIES` **두 곳을 같이** 바꿔야 합니다.

오른쪽 아래 토글로 다크모드를 켭니다. 선택은 브라우저에 남아서 페이지를 옮겨도 유지됩니다.

관리자 페이지는 공개 메뉴에 없습니다. `배포주소/admin/` 을 직접 여세요.

메뉴 상태는 주소에 남아서 그대로 공유할 수 있습니다.
`?view=book`, `?view=calendar`, `?date=2026-08-18`, `?q=닉네임`

도감 프사는 SOOP 프로필 주소를 자동으로 씁니다. 없는 아이디면 닉네임 첫 글자로 대신 나옵니다.

---

## 배포 순서

### 1. Supabase 프로젝트 만들기

1. https://supabase.com 에서 New project.
2. **Authentication → Users → Add user** 로 관리자 계정을 먼저 만듭니다.
   이메일·비밀번호를 넣고 **Auto Confirm User를 켭니다.**
   이 순서를 지키지 않고 SQL부터 돌리면 본인도 저장할 수 없습니다.
3. **SQL Editor** 에 `supabase.sql` 내용을 붙여넣고 Run.
4. **Project Settings → Data API** 에서 두 값을 복사합니다.
   - Project URL
   - anon public key

### 2. config.js 채우기

```js
window.DOOMI_CONFIG = {
  SUPABASE_URL: "https://abcdefgh.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
  SOOP_ID: "두미방송국아이디"
};
```

`SOOP_ID` 는 선택입니다. 넣으면 사이드바 프로필 사진을 SOOP에서 원본 크기로
가져오고, 두미가 SOOP 프사를 바꾸면 사이트도 따라 바뀝니다.
비워 두면 묶음에 든 `assets/doomi-profile.png`(100×100)를 씁니다.

anon 키는 공개되어도 되는 값입니다. 쓰기 권한은 키가 아니라
`supabase.sql`의 접근 권한(RLS)이 막습니다. 로그인하지 않으면
브라우저에서 무슨 짓을 해도 기록을 넣거나 지울 수 없습니다.

### 3. GitHub에 올리기

이 폴더의 내용을 그대로 새 저장소에 올립니다. 폴더 구조를 바꾸지 마세요.
`functions/` 폴더 위치가 바뀌면 룰렛 연동 API가 동작하지 않습니다.

### 4. Cloudflare Pages 연결

1. Cloudflare 대시보드 → Workers & Pages → Create → Pages → Connect to Git.
2. 저장소 선택. 빌드 설정은 비웁니다. (Framework preset = None,
   Build command 비움, Build output directory 비움)
3. Deploy.

### 5. Cloudflare 환경 변수 3개 넣기

Pages 프로젝트 → Settings → Variables and Secrets → Production에 추가.

| 이름 | 값 |
|---|---|
| `SUPABASE_URL` | `https://<프로젝트>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase의 **service_role** 키. Secret으로 저장 |
| `DOOMI_BRIDGE_TOKEN` | 직접 만든 32자 이상의 임의 문자열 |

service_role 키는 모든 권한을 가진 키입니다. 이 세 값은 서버에서만 읽히고
브라우저로 내려가지 않습니다. `config.js`에는 절대 넣지 마세요.

환경 변수를 넣은 뒤에는 **Deployments → 최신 배포 → Retry deployment** 로
한 번 다시 배포해야 값이 반영됩니다.

### 6. 룰렛업보정리기 연동

`weflab-bridge/README.txt` 를 따라갑니다.
`doomi-site-bridge.json`의 `token`은 5단계의 `DOOMI_BRIDGE_TOKEN`과
같은 값이어야 합니다.

---

## 숲 게시글에 넣기

게시글 편집기에서 HTML 로 아래를 넣습니다. **주소는 사이트 주소 그대로** 넣습니다.

```html
<iframe src="https://<사이트주소>/" height="2600" scrolling="no"
        style="width:100%;border:0;display:block;"></iframe>
```

### 높이는 얼마로?

숲은 iframe 높이를 픽셀로 박아야 합니다. 페이지가 스스로 높이를 알려줄 방법이 없어서
아래 표에서 골라 넣습니다. **애매하면 큰 쪽**을 고르세요.
아래쪽에 여백이 조금 남는 게 스크롤바가 두 개 생기는 것보다 낫습니다.

| 기록 수 | 높이 |
|---|---|
| 20건 이하 | 2200 |
| 50건 안팎 | 2600 |
| 100건 이상 | 3000 |

기본 화면은 20건까지만 보이고 "업보 더 보기" 를 눌러야 늘어나므로,
기록이 아무리 많아져도 2600 이면 대개 맞습니다.

### 앱에서 보면 모바일 배치로 뜹니다

숲 **앱** 안의 게시글은 iframe이라 화면 폭을 지정할 수 없습니다. 그래서 앱에서는
모바일 배치로 뜨고, 화면 위에 **`PC 화면 ↗`** 버튼이 나옵니다. 그걸 누르면
인앱 브라우저가 열리면서 PC 배치로 보입니다. 이 버튼은 게시글 안에서만 보이고
주소로 직접 들어왔을 때는 안 보입니다.

**폰 브라우저로 주소를 직접 열면 처음부터 PC 배치**로 나옵니다.

### 하지 말 것

- 게시글에 다른 페이지를 거쳐 들어가는 주소를 넣지 마세요. 숲 앱은 iframe 안의
  iframe을 못 견뎌서 게시글이 무한 새로고침 됩니다.
- iframe 주소에 `?pc=1` 을 붙이지 마세요. 그건 버튼으로 들어갔을 때만 쓰는 값입니다.

---

## 확인

| 확인할 것 | 방법 |
|---|---|
| 공개 페이지 | 배포 주소 접속 → 왼쪽 아래 배지가 "기록 연결됨" |
| 관리자 로그인 | `배포주소/admin/` → 1단계에서 만든 계정으로 로그인 |
| 등록 반영 | 관리자에서 저장 → 공개 페이지 새로고침하면 보임 |
| 권한 | 로그아웃 상태에서는 관리자 화면 자체가 열리지 않음 |

파일을 고쳐 다시 올린 뒤 화면이 그대로면 `Ctrl+Shift+R`.

---

## 자주 나오는 문제

| 증상 | 원인 |
|---|---|
| 관리자 로그인 화면에 "config.js에 …" 안내 | 2단계를 안 함. 이 안내는 관리자에만 뜨고 공개 페이지에는 안 나옵니다 |
| "debts 테이블이 없어요" | 1단계 3번 SQL을 안 돌림 |
| 로그인이 "이메일 또는 비밀번호가 맞지 않아요" | 계정 미생성, 또는 Auto Confirm User를 안 켬 |
| 관리자에서 저장 시 "권한이 없어요" | 세션 만료. 로그아웃 후 다시 로그인 |
| 룰렛 전송이 HTTP 401 | `DOOMI_BRIDGE_TOKEN`과 `doomi-site-bridge.json`의 token이 다름 |
| 룰렛 전송이 HTTP 503 | 5단계 환경 변수 누락, 또는 재배포를 안 함 |
| 룰렛 전송이 HTTP 404 | `functions/` 폴더가 저장소 최상위에 없음 |
| 게시글 아래에 빈 공간이 남음 | iframe height가 큼. 위 표에서 한 단계 낮추기 |
| 게시글 안에서 스크롤바가 두 개 | iframe height가 작음. 한 단계 올리기 |
| 게시글이 계속 새로고침됨 | iframe 주소가 사이트 주소가 아님(중첩 iframe) |
| 한 번에 등록에서 "분류를 모르겠어요" | 분류 칸을 룰렛 벌칙/약속/이벤트 중 하나로. 비우면 룰렛 벌칙 |

---

## 데이터 관리

기록은 전부 Supabase의 `debts` 표에 있습니다.
Supabase 대시보드 → Table Editor → debts 에서 직접 보거나 내보낼 수 있습니다.
전체 삭제는 SQL Editor에서 `delete from public.debts;`.
