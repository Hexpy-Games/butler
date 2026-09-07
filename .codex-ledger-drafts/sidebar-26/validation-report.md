# #26 검증·완성도 리뷰

기준: UI-SIDEBAR-INFORMATION-ARCHITECTURE r3 및 2026-09-07 메시지 하단 아이콘 배치 추가 요청.
구현/리뷰는 직접 수행했다. 서브에이전트는 사용하지 않았다.

## 승인된 제품 경로

| 범위 | 구현과 관찰 결과 |
| --- | --- |
| 혼합 트리·그룹 | 기존 App SQLite/navigation 경로 확장. 그룹 생성·세션 드롭 그룹화·이동·reload 후 동일 ID와 배치 보존 확인 |
| 탐색·메뉴 | 전체/최신/진행중, 고정 즐겨찾기/일반/설정, 위치·시간·상태 슬롯, native sticky. 모바일 long-press 메뉴와 숨겨진 more 확인 |
| 소속 이동 | 실제 Electron에서 일반→프로젝트→일반 이동 후 모델의 pwd가 목적지 프로젝트/Butler Data로 변경. 이전 합의와 메시지 유지 |
| 인라인 참조 | 실제 native mouse drag로 문장 중간 삽입. Electron 전송 parts가 DB에 저장되고 링크 재표시. 실제 모델이 read_conversation_session으로 원문 표식을 조회 |
| 주제 분리 | 일반의 실제 답변 버튼에서 주제/프로젝트 생성, seed 표시, 원문 복귀, 새 대화에서 합의 기억 확인 |
| 스마트 그룹 | 실제 configured openai/gpt-6-astra가 두 보험 대화를 한 단어 보험 그룹으로 분류. 별도 3초 deadline/max-output cap 없음 |
| 하단 액션 | 복사→새 주제대화→새 프로젝트→작업시간→메시지 시간. 아이콘/툴팁, 별도 텍스트 줄 없음 |

## 실제 검증에서 발견해 닫은 누락

- Electron api/preload가 send/queue/update-queue에서 content_parts를 버리던 연결을 수정했다.
- native drag 시작 시 composer가 접히던 동작을 수정했다.
- start_topic_conversation의 reviewed persistent effect adapter를 연결했다. 재확인은 같은 App 예약 키를 사용한다.
- 대화 검색의 external/canonical ID와 App ID를 기존 binding으로 해석한다. canonical 답변은 같은 대화의 공개 TurnOutcome와 App turn_id로 연결한다. 무관한 최신 답변으로 대체하지 않는다.
- 이동용 신규 Git 작업 폴더의 소유 기록을 생성 전에 저장하고, 중단 복구의 안전 정리가 대화 실행 gate를 점유하지 않도록 했다.

## 검증

- 집중 서버/저장/참조/이동/분류/bridge/effect 검사: 90 tests, 366 assertions 통과 (최종 코드 재실행).
- 하단 메타데이터/아이콘 검사: 4 tests, 24 assertions 통과.
- 행별 projection/인스턴스 marker 검사: 2 tests, 11 assertions 통과.
- typecheck, lint(DS/CSS 포함), UI production build, git diff --check 통과.
- Chromium 320/390/430px 및 데스크톱, 라이트/다크 화면 확인. 실제 iOS Safari 실기기 검증은 수행하지 않았다.
- UI 테스트는 파일별 독립 실행했다. 전체를 한 프로세스로 합치면 기존 module mock 오염으로 결과가 왜곡된다.
- 기존 main에서도 재현되는 UI behavior 3건과 app-client-design source assertion 7건은 별도 기존 실패로 기록했다. 기존 BTCC fast-suite fixture의 종료 불능/Project Work parity 실패도 main에서 확인했으며 이 기능을 위해 BTCC 계약을 바꾸지 않았다. 따라서 전체 저장소 테스트가 모두 초록이라는 주장은 하지 않는다.

## 경로와 한계

실제 모델 검사에는 기존 설정 자격으로 실행한 격리 Electron 제품을 사용했다. 가짜 모델/수동 결과 주입이 아니다.
스마트 분류·주제/프로젝트·이동·참조 1차 실행: sidebar-organization-live-1788783498737-47d8cbea.
자연어 도구 재검증: sidebar-organization-live-1788786919108-d3ffaa97. 실제 모델의 start_topic_conversation 호출이 성공했고, 새 대화 ‘별빛노트 다음 협의’와 원본 합의/출처가 저장됐다. effect applied receipt와 started=false를 확인했다.
실행 자료는 운영 데이터와 분리된 임시 run 디렉터리에 보존했다. 종료된 이전 run의 재생성 가능한 설치 패키지만 공간 확보를 위해 삭제했다.

남은 단계: commit/main 병합 → 운영 서비스/Electron 재시작 → 운영 상태 확인.
