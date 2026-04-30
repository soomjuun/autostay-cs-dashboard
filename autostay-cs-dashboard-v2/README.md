# [OPS] 채널톡 CS 대시보드 v4.0

채널톡 Open API v5 실데이터 기반 CS 운영 · SLA · VOC · 담당자 성과 통합 분석 대시보드.

## v4.0 주요 변경사항 (2026-04-30)

### 효율화
- **A-2** Hero 우측 → "지금 즉시 처리" 액션 박스 (헬스 게이지 → 인라인 이동)
- **A-1** VOC/Manager 영역을 **탭 구조**로 통합 (분포·리스크·해결시간·공출현·컴플레인 5탭 / 성과·분면도·집중도·FRT 4탭)

### 고도화
- **B-1** **FRT (First Response Time)** 측정 — `operationWaitingTime` 활용 + 담당자별 비교 테이블
- **B-2** **FCR (1차 해결률) / 재오픈율 / 반복 문의 고객** 통합 패널
- **B-3** **컴플레인 세분화** (서비스/시스템/가격/탈퇴/기타) — 누적 막대 추이 차트
- **B-7** 수집 한도 **300 → 1000건** (10페이지 × 100)

### 실용성
- **C-1** 채널톡 **딥링크** — 미배정 KPI / 8h+ 케이스 / 모달 클릭 시 채널톡 직접 이동
- **C-2** **필터 시스템** — 담당자/태그/채널 다중 필터, 활성 필터 배지

### 안정성
- **D-1** **Vercel KV 캐싱** — 5분 TTL, 매 호출마다 채널톡 API 호출 폭격 방지
- 메모리 fallback (KV 미설정 시) — Lambda 동안 유효
- 캐시 HIT/MISS 진단 패널 표시

## 기술 스택

- **Frontend**: Vanilla JS + Chart.js 4.4
- **Backend**: Vercel Serverless Functions (Node 22.x)
- **Data**: Channel Talk Open API v5
- **Cache**: Vercel KV (REST API) + in-memory fallback
- **Auth**: 쿠키 토큰 (`ds_auth`, 7일 유효)

## 폴더 구조

```
autostay-cs-dashboard/
├─ index.html         # 대시보드 메인
├─ style.css          # v4.0 스타일
├─ app.js             # 렌더링 + 필터 + 탭 + 딥링크
├─ api/
│  ├─ auth.js         # 토큰 인증 게이트
│  ├─ check.js        # 빠른 인증 체크
│  ├─ data.js         # 채널톡 API 프록시 + 캐싱 + FRT/FCR/세분화
│  └─ _cache.js       # Vercel KV / 메모리 캐시 헬퍼
├─ vercel.json        # maxDuration 30s
├─ package.json       # Node 22.x
├─ .env.example       # 환경변수 템플릿
└─ .gitignore
```

## 환경변수 (Vercel)

### 필수
| 변수명 | 설명 |
|---|---|
| `CHANNEL_ACCESS_KEY` | 채널톡 Open API Access Key |
| `CHANNEL_ACCESS_SECRET` | 채널톡 Open API Access Secret |
| `DASHBOARD_TOKEN` | 대시보드 접근 토큰 |

### 선택 (KV 캐싱)
Vercel 대시보드 → **Storage → KV** → Create → 프로젝트에 연결하면 자동 주입:
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

## 새 메트릭

### FRT (First Response Time)
- `operationWaitingTime` (채널톡 제공) → 첫 응답까지 걸린 시간
- 5분 SLA / 30분 SLA 계산
- 담당자별 평균 / P50 / P90 비교

### FCR (1차 해결률)
- `openedAt`이 `createdAt` + 1시간 이상 차이 → 재오픈으로 간주
- 재오픈율, 1차 해결률, 반복 문의 고객 수

### 컴플레인 세분화
태그 패턴 매칭으로 자동 분류:
- **시스템 오류**: 이용불가, 시스템, 오류, 버그, 결제, 앱, 로그인, 접속
- **서비스 품질**: 응대, 직원, 매장, 세차, 품질, 불친절 (+ 컴플레인)
- **가격/환불**: 요금, 가격, 환불, 취소, 할인 (+ 컴플레인)
- **탈퇴/해지**: 탈퇴, 해지
- **기타**: 위 외의 컴플레인 태그

## 보안 (v4.1 Package A)

### Edge Middleware
`middleware.js` — Vercel Edge에서 모든 요청 가로채기:
- 정적 리소스(`index.html`, `style.css`, `app.js`)도 인증 후에만 제공
- 인증 없이 접근 시 → HTML은 `/api/auth`로 redirect, 정적 리소스는 401 응답
- `/api/auth`, `/api/check`, `favicon` 등은 우회 (인증 페이지 자체)

### 쿠키 키 환경변수화
- 기존: `ds_auth` 코드에 하드코딩 (소스 노출 시 위조 가능)
- v4.1: `COOKIE_KEY` 환경변수로 관리 — 노출 의심 시 변경하면 모든 세션 무효화

### 보안 헤더 (`vercel.json`)
| 헤더 | 값 | 효과 |
|---|---|---|
| `X-Frame-Options` | `DENY` | iframe 임베드 차단 (clickjacking) |
| `X-Content-Type-Options` | `nosniff` | MIME sniffing 방지 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Referer 누출 최소화 |
| `Permissions-Policy` | `camera=(), microphone=()...` | 권한 차단 |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | HTTPS 강제 |
| `X-Robots-Tag` | `noindex, nofollow` | 검색엔진 인덱싱 차단 |
| `Content-Security-Policy` | (개별 설정) | XSS / 외부 리소스 통제 |

### 쿠키 보안 강화
- `HttpOnly` (JS 접근 차단)
- `Secure` (HTTPS 전용)
- `SameSite=Lax` (CSRF 방지)

## 라이선스

내부 운영용 — All Rights Reserved.
