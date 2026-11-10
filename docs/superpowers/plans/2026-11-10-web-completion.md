# GridWitness 웹 완성도 수정 계획

> 실행: 현재 격리된 작업 폴더에서 구현하고, 독립 영역만 병렬로 처리한다. 사용자가 전체 점검 결과의 수정과 우노 실측 검증을 요청했다.

**Goal:** 점검 문서 W01~W19의 소프트웨어 결함을 수정하고, 우노 실측과 브라우저·API 흐름을 확인한다.

**Architecture:** React/TypeScript와 FastAPI를 유지한다. 사건의 기준 기록은 서버에 두고 브라우저는 재시도 가능한 캐시로 사용한다. LLM 응답 출처·실패 사유·모델 준비 상태를 표시한다. 중국·러시아 모델의 계약을 별도로 다룬다.

**Spec:** `C:/Users/user/Desktop/한전/GridWitness_웹전체점검_2026-11-10.md` 및 현재 사용자 요청.

## Global Constraints

- 실제 계측과 시뮬레이터를 구분한다. 없는 센서·근거·모델·GPU 연결을 있다고 표시하지 않는다.
- 기존 package-lock.json의 사용자 변경과 API DB를 되돌리거나 커밋하지 않는다.
- 웹은 팀원 저장소 기준 PR로 전달한다. 공유 main에 직접 푸시하거나 임의 머지하지 않는다.
- 원시 파형·검토·AI 결과를 파괴적으로 삭제하지 않는다. 대화 초기화는 보관 범위를 명확히 한다.
- 한국어 UI와 문서를 유지한다. 인증은 설정 가능한 접근 토큰을 지원하며 공개 배포의 접근 범위를 임의로 잠그지 않는다.
- 운영 배포 전 테스트·백업·시험 실행을 완료한다.

## Shared Interfaces

- API: `GET /api/v1/capabilities` → `{models: [...], assistant: {configured, model, available?}, auth: {required}}`.
- API: `GET /api/v1/village/records?kind=event|incident|iot_case&page=1&per_page=100` → `{items:[{record_id,kind,device_id,data,created_at,updated_at}],page,per_page,total_count}`.
- API: `PUT /api/v1/village/records/{record_id}` body `{kind,device_id,data}` → persisted record. IDs are client-generated UUIDs/ASCII keys; updates are idempotent.
- Frontend village adapter: `listVillageRecords(kind)` and `saveVillageRecord(recordId, kind, deviceId, data)` plus a local persistent pending queue. API caller uses shared request headers and configured base.
- Assistant response preserves `answer_mode`, `llm_model`, fallback reason; conversation history remains server-side and recent turns are supplied to the LLM.
- Incident registration accepts optional `title`, `actor`, `label_meaning`, original COMTRADE metadata/files; responses preserve metadata across browsers.

## Review Focus

- A cached record must refresh after another device changes or archives it; a network failure must retain data with an explicit stale/pending state.
- Raw UNO event counter restarts must not overwrite an earlier recording; persistence must tolerate unavailable backend and full browser storage.
- Invalid/non-finite serial samples must not become real 0V measurements.
- Model-specific channels and labels must survive upload → validation → analysis → assistant → report without fabricating channels.
- LLM failure, cancellation and a local fallback turn must not silently lose or mislabel the conversation.

## Task 1 — API contracts and durable records

- [ ] Add failing pytest cases for model-specific validation, title/actor persistence, village records across sessions, assistant metadata/history and access-token checks.
- [ ] Implement additive database migration/fields, record API, model capabilities and optional bearer-token enforcement. Preserve existing DB.
- [ ] Strengthen grounded LLM response validation, bounded history/timeout and status/fallback output.
- [ ] Run API suite and report any environment-dependent failure explicitly.

## Task 2 — Waveform and case data flow

- [ ] Add regression tests for cold list stage, cache refresh/archive, complete export, metadata, model-specific channels/labels and uncertain recovery.
- [ ] Correct server synchronization and export hydration; scope caches to API base; connect IoT case persistence to village records.
- [ ] Support native CN/RU contracts consistently through validation, plots, scores, context and reports; reject unsupported input accurately.
- [ ] Correct waveform recovery/onset claims and unify 2D/3D markers.
- [ ] Run regressions and production build.

## Task 3 — Assistant and village persistence

- [ ] Add regression tests for reply-mode metadata, local/server history merge, clear-chat scope and no-data answers.
- [ ] Preserve LLM/rules/model/fallback details, cancellation and timeout; keep local pending turns visible.
- [ ] Persist raw village events and live incidents via the shared record API with a durable retry queue.
- [ ] Align voice error handling and disconnected-data answers.
- [ ] Run regressions and build.

## Task 4 — Shared connection settings and device boundary

- [ ] Add Node TypeScript test loader/run command without changing dependency versions or the existing lockfile.
- [ ] Add shared API header/timeout/error utilities and capabilities status. Update settings, model descriptions and periodic health.
- [ ] Reject invalid serial data and repair connection/resource cleanup. Add unknown-route recovery.
- [ ] Remove unsubstantiated voltage text, update data-storage descriptions and reports.
- [ ] Verify build/lint and meaningful regressions.

## Task 5 — Hardware, deployment and end-to-end verification

- [ ] Read actual COM19 samples and sensor startup status, preserving any existing browser ownership.
- [ ] Exercise the browser with native Web Serial where possible; verify a channel command and its recorded response, restoring original channel states.
- [ ] Back up and stage API deployment; verify existing records and new endpoint contracts before switching.
- [ ] Attach real LLM only if a reachable model endpoint is available; otherwise surface the exact missing dependency.
- [ ] Re-run browser routes, mobile, raw-event persistence/reload, cross-browser case refresh/export and assistant fallback scenarios.

## Task 6 — Review and delivery

- [ ] Independent review of the integrated changes; fix important findings with regression coverage.
- [ ] Commit only task files; push feature branches and open/update PRs with validation.
- [ ] Update the audit status with fixed/verified/unavailable distinctions and actual deployment identifiers.

## Task 7 — Full program audit additions

- [x] Rebase the review target conceptually to the user-confirmed ParksKin `main`; the existing coelacanth workspace differs in FRTU UI files, so implementation uses an isolated tree from current ParksKin main.
- [x] Inspect every route/API entry point, shared API transport, data source labels, persistence tests, and current public deployment/API read responses.
- [x] Correct misleading LLM readiness status; distinguish Ollama model-list probe from successful generated/accepted answers.
- [x] Route KEPCO usage requests through shared API auth, timeout, and structured error handling.
- [x] Correct stale GitHub Pages/CORS documentation and document CN/RU model contracts and the current server-analysis behavior.
- [ ] Complete visual browser route/mobile review. Current system Chromium/Edge headless command fails before rendering (`Multiple targets are not supported in headless mode`).
- [ ] After the code PR is deployed, repeat the browser → UNO → API persistence/reload test. Do not open or claim UNO port ownership during another app's active session.
- [ ] Reconcile production blockers that require external action: INA219 0x41 hardware repair, GPU-backed approved LLM validation, API auth policy/deployment, and server migration before 2026-11-20 expiry.

