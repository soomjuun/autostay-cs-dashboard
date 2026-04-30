# [OPS] 채널톡 CS 대시보드

채널톡 Open API v5 실데이터 기반 CS 운영 · SLA · VOC · 담당자 성과 통합 분석 대시보드.

## 주요 기능

### 기본 분석
- CS 건강 점수 (4단계 등급)
- 핵심 KPI 5종 (미배정 / 오픈 / 8시간+ / 컴플레인율 / 담당자 편중)
- 일별 트렌드 + 7일 이동평균 + 피크 분석
- 요일·시간 히트맵
- 태그 분포 + VOC 리스크 카드
- 담당자 성과 (운영점수 / 응대점수 / 평균해결시간)
- 8시간+ 장기 지연 drill-down

### 고도화 분석 (v3.0 — Advanced Intelligence)
- **기간 비교 (WoW)** — 직전 동일 기간 대비 증감
- **SLA 트래커** — 30분 / 2시간 / 8시간 SLA 준수율
- **시간대 부하 곡선** — 24시간 분포 + 4분 시간대 집계
- **요일별 부하 + 영업/비영업시간 분리** — 평일 09-19 KST 기준
- **해결시간 백분위수** — P50 / P75 / P90 / P95
- **에이징 파이프라인** — <8h, 8-24h, 1-3d, 3-7d, 7d+
- **태그별 해결시간 분석** (TOP 10)
- **태그 공출현 패턴** (TOP 8)
- **채널별 성능 비교** — native / phone / other
- **이상치 탐지** — Z-score ±1.8σ 기준
- **볼륨 모멘텀 & 다음날 투영**
- **일별 컴플레인 비율 추이 차트**
- **담당자 성과 매트릭스** — 속도 × 처리량 4분면도
- **API 진단 패널** — 호출별 응답시간, 부분실패 추적

## 기술 스택

- **Frontend**: Vanilla JS + Chart.js 4.4
- **Backend**: Vercel Serverless Functions (Node 22.x)
- **Data Source**: Channel Talk Open API v5
- **Auth**: 쿠키 기반 토큰 인증
- **Deploy**: Vercel

## 폴더 구조

```
autostay-cs-dashboard/
├─ index.html         # 대시보드 메인 페이지
├─ style.css          # v3.0 스타일 (1900+ 라인)
├─ app.js             # 렌더링 로직 (3000+ 라인)
├─ api/
│  ├─ auth.js         # 토큰 인증 게이트
│  ├─ check.js        # 빠른 인증 체크 endpoint
│  └─ data.js         # 채널톡 API 프록시 + 데이터 가공
├─ vercel.json        # Vercel 배포 설정 (maxDuration 30s)
├─ package.json       # Node 22.x
├─ .env.example       # 환경변수 템플릿
└─ .gitignore
```

## 환경변수 설정

Vercel 프로젝트 설정 → Environment Variables 에 다음 3개 등록:

| 변수명 | 설명 | 필수 |
|---|---|---|
| `CHANNEL_ACCESS_KEY` | 채널톡 Open API Access Key | ✅ |
| `CHANNEL_ACCESS_SECRET` | 채널톡 Open API Access Secret | ✅ |
| `DASHBOARD_TOKEN` | 대시보드 접근 토큰 (비워두면 인증 없음) | ⚠️ 운영 권장 |

### 채널톡 API 키 발급
1. 채널톡 데스크 → 설정 → 보안 → 통합 → **공개 API**
2. **새 앱 만들기** → Access Key / Access Secret 발급
3. 권한: `userChat`, `manager`, `bot`, `group`, `channel` 읽기 권한 부여

## 로컬 개발

```bash
npm i -g vercel
cp .env.example .env.local
# .env.local 에 실제 키 입력
vercel dev
# → http://localhost:3000
```

## 배포

```bash
git push origin main
```
Vercel 자동 재배포 (1-2분).

## 보안 주의사항

- ⚠️ **API 키는 절대 코드에 하드코딩하지 마세요.** 모든 시크릿은 Vercel 환경변수로만 관리합니다.
- ⚠️ Public 저장소를 사용한다면 `DASHBOARD_TOKEN` 을 반드시 설정해 무단 접근을 차단하세요.
- 🔒 인증 쿠키는 `HttpOnly` + `SameSite=Lax` 로 발급되며 7일 유효기간을 가집니다.

## 라이선스

내부 운영용 — All Rights Reserved.
