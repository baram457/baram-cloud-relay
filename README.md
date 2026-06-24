# 바람 V10.78Q Capital.com 데모 중계 서버

기준: V10.66 유지

## Render 환경변수 3개

Render → Service → Environment 에 아래 3개를 넣으세요.

```txt
CAPITAL_API_KEY=Capital.com에서 생성된 API key
CAPITAL_IDENTIFIER=Capital.com 로그인 이메일
CAPITAL_PASSWORD=API 키 만들 때 넣은 Custom password
```

기본값:

```txt
CAPITAL_DEMO=true
```

## Render 설정

```txt
Build Command: npm install
Start Command: npm start
```

## 확인 주소

서버 배포 후 아래 주소가 열리면 정상입니다.

```txt
https://본인-render주소/health
```

아래 주소에서 Capital.com 연결 상태를 확인합니다.

```txt
https://본인-render주소/api/capital/status
```

아래 주소에서 종목 epic 자동검색 결과를 확인합니다.

```txt
https://본인-render주소/api/capital/epics
```

## 지원 종목

```txt
NQ     = US Tech 100 대용
GOLD   = Gold
SILVER = Silver
OIL    = Crude Oil
HSI    = Hong Kong 50 대용
```

BTC는 기존 HTML에서 Binance 직접 연결을 그대로 사용합니다.

## 자동 epic 검색이 틀릴 때

Render 환경변수에 직접 epic을 추가할 수 있습니다.

```txt
CAPITAL_EPIC_NQ=직접 확인한 epic
CAPITAL_EPIC_GOLD=직접 확인한 epic
CAPITAL_EPIC_SILVER=직접 확인한 epic
CAPITAL_EPIC_OIL=직접 확인한 epic
CAPITAL_EPIC_HSI=직접 확인한 epic
```


## V10.78Q 수정
- US100 등 일부 종목에서 `/markets?epics=`가 빈 값으로 오는 경우, 자동검색 결과의 market quote를 fallback으로 사용합니다.
- `quote market empty: US100` 오류 방지.
- force redeploy 1078Q
