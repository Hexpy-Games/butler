# I1 원문 등록·회상 독립화 결과

## 범위
SPEC-MEMORY-SOURCE-GRAPH-REDESIGN의 I1을 독립 worktree에서 구현했다. 기존 복구 운영 코드는 수정하지 않았다. 기존 복구와30분 automation은 별도 세션01a0961d-8382-79a1-ae02-7b1054086930이 담당한다.
현재 태스크 분할은 단순 문서작성/코드 구분보다 실제 수직 결과 기준으로 정리한다. 기존 T-MEMORY-SOURCE-GRAPH-DESIGN은 상세화와 I1 구현·리뷰를 함께 담으며, 다음 T-MEMORY-SOURCE-GRAPH-IMPLEMENT가 I2/I3 및 최종스키마 상세화를 담당한다. 전체개선 완료 아님. 모델별 벤치마크와 운영 적용은 보류.

## 동작과 논리 리뷰
원문 등록과 색인을 같은 트랜잭션에서 쓴다. extractor나 B 단계는 이 색인의 생성 조건이 아니다. 동일source ID 재등록은 텍스트해시가 같으면 재사용하고 다르면 거부한다. 분할 부모의 원문/근거를 유지하고 자식도 색인한다.
recallSourceBackedMemory는 기존 실제 경로에서 원문색인 후보를 graph/vector 후보와 합친다. 범위·현행revision·active·시각 필터 후 LIMIT을 적용하며 요약이 없는 원문을 발췌로 반환한다. 직접원문 결과는 unclassified_source로 표시한다. 긴 원문의 검색어 주변을 원어 그대로 발췌하고 정규화문자열을 원문으로 반환하지 않는다. 기존 vector-only 후보 처리 유지, 원문과 같은episode의 무관한 해석을 임의로 요약으로 채우지 않는다.
기존 source/index/recall 소유 모듈에 연결했다. 새로 만든 source-index(영속색인), source-index-migration(원문하이드레이션과재개), source-excerpt(원문발췌)는 실제 ingestion/recall/CLI 소비자가 있다. 기존 대형store/ingestion/engine의 해당 경로만 수정했으며 파일크기 맞추기용 분할은 하지 않았다.

## 검증
- public ingress→recall 새3검사: 한국어/일본어/아랍어/결합문자/1글자, 긴원문후반발췌, 모델실패후원문회상, 타세션배제, 재등록중복방지, 뒤에205대화가추가된오래된원문회상.
- source-index + extractor-contract + recall-conditions:13pass/102assertions.
- source-index + vector-recall:21pass/99assertions. 위3개신규검사는 중복집계이므로 총34개라고 주장하지 않는다.
- backendtypecheck 통과, 변경파일eslint 오류0(ingestion의기존unused sourceRoot 경고1), diffcheck 통과.
- 모듈구조검사: 신규핵심3파일신호0. 기존대형모듈은 실제수직경로를유지한범위로수동리뷰.

## 일회 색인 이전 측정
진행중복구DB의일관된개발용복사본에서원문1322구간(UTF8 1055096bytes)을이전했다. canonical source snapshot은읽기전용이고운영DB는수정하지않았다. 결과: indexed1322,remaining0,failures0,FK오류0,모델호출0.
첫문자열ID색인은19.4초였으며긴ID중복저장을제거한정수키색인은3.39초,812739postings,할당24883200bytes(약23.73MiB)였다. 후자크기는격리DB의rollbacktransaction에서해당색인테이블해제시freepage변화로측정했다. 이결과는단일로컬개발실행이고캐시/부하통제벤치마크가아니다.
재실행indexed0/remaining0/failures0/modelCalls0,1.86ms. 전체기억의미재추출이나최종신규스키마이전이완료된것은아니다.
측정/검사원본은 /tmp/butler-memory-source-graph-20260913/ 및 /tmp/memory-source-index-*.log.

## 다음 단계 및 잔여
I2: entity와claim의실제저장소분리, 직접언급과근거연결구분, A유효결과의독립저장/B결합. I3: 출처권한/요청분류/정정/캐시의존성. I4: 최종전체스키마이전과전체수용. 의미별모델호출을늘리는호환층을만들지않는다. 본단계검사로사실판정·모든언어정확성·전체검색성능을보증하지않는다.
