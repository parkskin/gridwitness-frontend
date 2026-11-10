// GridWitness 마을 정전 모니터링 모형 — 채널 릴레이 구성
//   5V DC 어댑터 → 1채널 릴레이(D2, COM→NC 사용, 마을 전체 전원)
//     → INA219 ① 0x40 → 채널 릴레이 ①~③ (D3~D5) → 주택 1·3·2 LED (배선상 주택 2·3이 바뀌어 있음: D4 = 주택 3, D5 = 주택 2)
//     → INA219 ② 0x41 → 채널 릴레이 ④~⑤ (D6~D7) → 가로등 1~2 LED
//   INA219 두 개: A4(SDA), A5(SCL) 공통
//
// 웹(Web Serial, 115200 baud)과 줄 단위로 통신합니다.
// INA219가 1개만 연결된 경우(0x40 또는 0x41 자동 감지)에는 마을 전체 값(v·i)만 보내고 구간 값은 생략합니다.
//   장치 → 웹 (0.5초마다):
//     {"v":5.02,"i":0.281,"relay":1,"ch":[1,1,1,1,1],"vh":5.02,"ih":0.168,"vl":5.01,"il":0.113}
//       v·i      : 마을 전체 (두 구간 합계)          relay : 마을 전원이 들어가 있으면 1
//       ch       : 채널 1~5 릴레이 상태 (1 = 켜짐)   vh·ih : 주택 구간 (INA219 ①)   vl·il : 가로등 구간 (INA219 ②)
//   장치 → 웹 (사건이 날 때만, v3.1): 사건 앞뒤 전류를 10 ms 간격으로 녹화한 '사건 파형'
//     {"ev":3,"dt":10,"pre":60,"src":"auto","cmd":"","ch":[1,1,1,1,1],"i":[2841,2840,...]}
//       ev  : 사건 번호         dt : 샘플 간격(ms)      pre : 사건 시점 앞쪽 샘플 수
//       src : auto = 명령 없이 전류가 갑자기 변함 / cmd = 웹 명령(개폐) 직후
//       cmd : src=cmd 일 때 받은 명령   ch : 녹화가 끝났을 때 채널 상태
//       i   : 마을 전체 전류, 0.01 mA 단위 정수 (최대 pre + 200개; 부팅 직후는 실제 확보한 pre만 보냄)
//   웹 → 장치:
//     RELAY 0 / RELAY 1   마을 전체 정전 / 복구
//     CH <1~5> <0|1>      채널 하나 끄기 / 켜기   (예: CH 3 0 → 주택 2 소등)
//
// 필요 라이브러리: Adafruit INA219

#include <Wire.h>
#include <Adafruit_INA219.h>

// ── 배선에 맞게 조정 ──────────────────────────────────
const uint8_t MASTER_PIN = 2;
// 전체 릴레이를 COM→NC로 연결: 코일이 꺼져 있을 때 전원이 들어감 (NO로 연결했다면 false)
// 웹에서 '정전 발생'을 눌러도 LED가 안 꺼지면 이 값을 반대로 바꿔 보세요.
const bool MASTER_USES_NC = false;
const uint8_t CH_PINS[5] = {3, 4, 5, 6, 7};  // 주택 1, 주택 3, 주택 2, 가로등 1~2 (실제 배선)
// 채널 릴레이를 COM→NO로 연결: 코일이 켜져야 LED가 켜짐 (NC로 연결했다면 true)
const bool CH_USES_NC = false;
// 릴레이 모듈이 LOW 입력에서 코일이 켜지면(Active-Low) true
const bool RELAY_ACTIVE_LOW = false;
// ──────────────────────────────────────────────────

Adafruit_INA219 inaHouse(0x40);
Adafruit_INA219 inaLamp(0x41);
bool houseOk = false;
bool lampOk = false;

bool powerOn = true;                       // 마을 전원
bool chOn[5] = {true, true, true, true, true};

const unsigned long PERIOD_MS = 500;
unsigned long lastSend = 0;
String line;

// ── 사건 녹화 (v3) ─────────────────────────────────────
// 10 ms마다 전류를 링 버퍼에 넣다가, 평소 값에서 TRIG 이상 벗어나거나 명령을 받으면
// 그 앞 PRE개 + 뒤 POST개를 한 줄로 보낸다. 녹화 중에는 0.5초 측정 줄을 쉰다 (샘플 간격이 흔들리지 않게)
// v3 는 5 ms × 260 = 1.3초(뒤 1.0초)였는데, 손으로 선을 들었다 꽂는 데 1초를 넘는 일이 많아 순간 접촉 불량이
// 녹화 안에서 단선처럼 보였다. 메모리는 그대로 두고 간격만 10 ms 로 늘려 뒤 2.0초를 본다 (깜빡임 수십~수백 ms 는 10 ms 로 충분)
const uint8_t SAMPLE_MS = 10;
const uint16_t PRE = 60;    // 0.6초
const uint16_t POST = 200;  // 2.0초
const uint16_t RB = PRE + POST;
const int16_t TRIG = 150;   // 1.5 mA (0.01 mA 단위). LED 1개 ≈ 10 mA
int16_t ring[RB];
uint16_t head = 0;          // 다음에 쓸 자리
uint16_t filled = 0;
long base100 = -1;          // 평소 전류 × 100 (0.01 mA 단위 × 100, 천천히 따라감)
uint16_t postLeft = 0;      // 녹화 중이면 남은 샘플 수
bool capCmd = false;
String capCmdText;
uint16_t capPre = PRE;
uint16_t evNo = 0;
unsigned long lastSample = 0;
unsigned long quietUntil = 0;

void startCapture(bool byCmd, const String& cmd);  // 아래에 정의 (명령을 받으면 녹화 시작)

// 원하는 상태(on)를 코일 구동 여부로 바꿔 핀에 씀
void driveRelay(uint8_t pin, bool on, bool usesNc) {
  bool coil = usesNc ? !on : on;
  bool level = RELAY_ACTIVE_LOW ? !coil : coil;
  digitalWrite(pin, level ? HIGH : LOW);
}

void applyAll() {
  driveRelay(MASTER_PIN, powerOn, MASTER_USES_NC);
  for (uint8_t k = 0; k < 5; k++) driveRelay(CH_PINS[k], chOn[k], CH_USES_NC);
}

void handleCommand(const String& cmd) {
  if (cmd == "RELAY 1") powerOn = true;
  else if (cmd == "RELAY 0") powerOn = false;
  else if (cmd.startsWith("CH ") && cmd.length() >= 6) {
    int n = cmd.charAt(3) - '0';
    char s = cmd.charAt(5);
    if (n < 1 || n > 5 || (s != '0' && s != '1')) return;
    chOn[n - 1] = s == '1';
  } else return;
  applyAll();
  startCapture(true, cmd);
}

// 부하 쪽 전압 = 버스 전압 + 션트 전압
float loadVoltage(Adafruit_INA219& ina, bool ok) {
  float v = ok ? ina.getBusVoltage_V() + ina.getShuntVoltage_mV() / 1000.0 : 0;
  return isnan(v) || isinf(v) ? 0 : v;  // nan·inf가 찍히면 웹이 줄을 못 읽음
}
float loadCurrent(Adafruit_INA219& ina, bool ok) {
  float i = ok ? ina.getCurrent_mA() / 1000.0 : 0;
  return isnan(i) || isinf(i) || i < 0 ? 0 : i;
}

// 마을 전체 전류 (0.01 mA 단위 정수)
int16_t totalCurrent100() {
  float a = loadCurrent(inaHouse, houseOk) + loadCurrent(inaLamp, lampOk);
  long u = (long)(a * 100000.0 + 0.5);
  return u > 32767 ? 32767 : (int16_t)u;
}

void startCapture(bool byCmd, const String& cmd) {
  if (postLeft > 0) return;  // 이미 녹화 중
  // 명령이 부팅 직후 들어오면 링 버퍼의 초기 0을 실측처럼 내보내지 않는다.
  capPre = filled < PRE ? filled : PRE;
  postLeft = POST;
  capCmd = byCmd;
  capCmdText = byCmd ? cmd : String();
}

void dumpCapture() {
  evNo++;
  Serial.print(F("{\"ev\":"));
  Serial.print(evNo);
  Serial.print(F(",\"dt\":"));
  Serial.print(SAMPLE_MS);
  Serial.print(F(",\"pre\":"));
  Serial.print(capPre);
  Serial.print(F(",\"src\":\""));
  Serial.print(capCmd ? F("cmd") : F("auto"));
  Serial.print(F("\",\"cmd\":\""));
  Serial.print(capCmdText);
  Serial.print(F("\",\"ch\":["));
  for (uint8_t k = 0; k < 5; k++) {
    if (k) Serial.print(',');
    Serial.print(chOn[k] ? 1 : 0);
  }
  Serial.print(F("],\"i\":["));
  const uint16_t captureLength = capPre + POST;
  const uint16_t captureStart = (head + RB - captureLength) % RB;
  for (uint16_t n = 0; n < captureLength; n++) {
    if (n) Serial.print(',');
    Serial.print(ring[(captureStart + n) % RB]);
  }
  Serial.println(F("]}"));
  // 끝난 뒤의 값을 새 평소 값으로 (영구 단선이면 낮아진 값이 평소가 됨)
  long sum = 0;
  for (uint8_t n = 1; n <= 20; n++) sum += ring[(head + RB - n) % RB];
  base100 = sum * 100 / 20;
  quietUntil = millis() + 200;
}

void sampleTick() {
  int16_t v = totalCurrent100();
  ring[head] = v;
  head = (head + 1) % RB;
  if (filled < RB) filled++;
  if (postLeft > 0) {
    if (--postLeft == 0) dumpCapture();
    return;
  }
  if (base100 < 0) base100 = (long)v * 100;
  long dev = (long)v * 100 - base100;
  if (filled >= PRE && millis() >= quietUntil && (dev > (long)TRIG * 100 || dev < -(long)TRIG * 100)) {
    startCapture(false, String());
    return;
  }
  base100 += dev / 32;  // 평소 값은 천천히 따라감
}

// 테스트 코드와 같은 I2C 주소 스캔. 센서가 어느 주소로 잡히는지 시작할 때 알려줌
void scanI2C() {
  Serial.println(F("#--- I2C scan ---"));
  int count = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print(F("#found 0x"));
      if (addr < 16) Serial.print('0');
      Serial.println(addr, HEX);
      count++;
    }
  }
  if (count == 0) Serial.println(F("#no I2C device found (SDA/SCL wiring?)"));
  Serial.println(F("#----------------"));
}

void setup() {
  Serial.begin(115200);
  // '#'로 시작하는 줄은 웹이 진단용 안내로만 읽는다 (측정값이 아님)
  Serial.println(F("#GridWitness village sketch v3.1 (event capture 10ms) - booting"));
  pinMode(MASTER_PIN, OUTPUT);
  for (uint8_t k = 0; k < 5; k++) pinMode(CH_PINS[k], OUTPUT);
  applyAll();
  Wire.begin();
  Wire.setClock(400000);  // 5 ms마다 읽어도 여유 있게
#if defined(WIRE_HAS_TIMEOUT)
  // SDA/SCL 배선이 잘못되면 I2C에서 영원히 멈출 수 있어 3ms 뒤 포기하게 함
  Wire.setWireTimeout(3000, true);
#endif
  delay(500);  // 센서 전원이 안정될 때까지 (테스트 코드와 동일하게 여유를 둠)
  scanI2C();
  Serial.println(F("#looking for INA219 0x40 (house)..."));
  houseOk = inaHouse.begin();
  if (houseOk) inaHouse.setCalibration_16V_400mA();  // 모형 전류는 수십 mA → 저전류 범위(0.05 mA 단위)
  Serial.println(F("#looking for INA219 0x41 (lamp)..."));
  lampOk = inaLamp.begin();
  if (lampOk) inaLamp.setCalibration_16V_400mA();
  Serial.print(F("#INA219 house(0x40)="));
  Serial.print(houseOk ? F("OK") : F("NOT FOUND"));
  Serial.print(F(" lamp(0x41)="));
  Serial.println(lampOk ? F("OK") : F("NOT FOUND"));
  if (houseOk != lampOk) Serial.println(F("#sensor 1개만 감지: 마을 전체 값으로 보냅니다 (구간 값 없음)"));
  if (!houseOk && !lampOk) Serial.println(F("#INA219 없음: v·i는 0으로 보냅니다. 배선을 확인하세요"));
}

// 센서 값을 읽어 줄로 내보낸다. 센서 개수에 따라 형식이 달라진다
void printSensors() {
  float vh = loadVoltage(inaHouse, houseOk);
  float ih = loadCurrent(inaHouse, houseOk);
  float vl = loadVoltage(inaLamp, lampOk);
  float il = loadCurrent(inaLamp, lampOk);
  bool both = houseOk && lampOk;
  float v, i;
  if (both) {
    v = vh > vl ? vh : vl;
    i = ih + il;
  } else if (houseOk) {
    v = vh; i = ih;  // 센서 1개 = 마을 전체
  } else if (lampOk) {
    v = vl; i = il;
  } else {
    v = 0; i = 0;
  }
  Serial.print("{\"v\":");
  Serial.print(v, 3);
  Serial.print(",\"i\":");
  Serial.print(i, 5);  // 0.01 mA 자리까지 (센서 분해능 0.05 mA)
  Serial.print(",\"relay\":");
  Serial.print(powerOn ? 1 : 0);
  Serial.print(",\"ch\":[");
  for (uint8_t k = 0; k < 5; k++) {
    if (k) Serial.print(',');
    Serial.print(chOn[k] ? 1 : 0);
  }
  Serial.print("]");
  if (both) {
    Serial.print(",\"vh\":");
    Serial.print(vh, 3);
    Serial.print(",\"ih\":");
    Serial.print(ih, 5);
    Serial.print(",\"vl\":");
    Serial.print(vl, 3);
    Serial.print(",\"il\":");
    Serial.print(il, 5);
  }
  Serial.println("}");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      line.trim();
      handleCommand(line);
      line = "";
    } else if (line.length() < 32) {
      line += c;
    }
  }

  unsigned long now = millis();
  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    sampleTick();
  }
  if (postLeft > 0) return;  // 녹화 중에는 측정 줄을 쉰다
  if (now - lastSend < PERIOD_MS) return;
  lastSend = now;

  printSensors();
}
