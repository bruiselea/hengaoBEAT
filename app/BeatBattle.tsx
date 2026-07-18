"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const VISION_BUNDLE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";
const VISION_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const BPM = 108;
const TOTAL_BEATS = 16;
const BEAT_MS = 60_000 / BPM;

type Gesture = "kick" | "snare" | "hat";
type Phase = "intro" | "camera" | "ready" | "playing" | "result" | "final";

type Expression = { mouth: number; smile: number; brow: number };
type Hit = { type: Gesture; at: number; power: number; beat: number };
type Score = {
  total: number;
  groove: number;
  face: number;
  variety: number;
  power: number;
  title: string;
  comment: string;
  hits: number;
};
type Performance = { player: 1 | 2; score: Score; hits: Hit[] };

type FaceLandmarkerLike = {
  detectForVideo: (video: HTMLVideoElement, now: number) => {
    faceLandmarks?: Array<Array<{ x: number; y: number }>>;
    faceBlendshapes?: Array<{ categories?: Array<{ categoryName: string; score: number }> }>;
  };
  close: () => void;
};

const gestureInfo: Record<Gesture, { label: string; face: string }> = {
  kick: { label: "KICK", face: "口を大きく開く" },
  snare: { label: "SNARE", face: "ニヤッと笑う" },
  hat: { label: "HI-HAT", face: "眉を上げる" },
};

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

function judgePerformance(hits: Hit[], expressionEnergy: number[]): Score {
  if (hits.length === 0) {
    return { total: 8, groove: 5, face: 10, variety: 5, power: 8, hits: 0, title: "無のビート", comment: "静寂も音楽。でも次は顔面を解放してみよう！" };
  }

  const distances = hits.map((hit) => {
    const position = hit.at / BEAT_MS;
    return Math.abs(position - Math.round(position));
  });
  const tightness = 1 - clamp(average(distances) / 0.42);
  const groove = Math.round(clamp(0.38 + tightness * 0.62) * 100);

  const maxFace = expressionEnergy.length ? Math.max(...expressionEnergy) : 0;
  const avgFace = average(expressionEnergy);
  const face = Math.round(clamp(maxFace * 0.68 + avgFace * 0.5) * 100);

  const used = new Set(hits.map((hit) => hit.type)).size;
  const densityBonus = clamp(hits.length / 20);
  const variety = Math.round(clamp((used / 3) * 0.78 + densityBonus * 0.22) * 100);

  const averagePower = average(hits.map((hit) => hit.power));
  const power = Math.round(clamp(averagePower * 0.82 + Math.min(hits.length, 16) / 16 * 0.18) * 100);
  const total = Math.round(groove * 0.34 + face * 0.29 + variety * 0.2 + power * 0.17);

  let title = "顔面ビート職人";
  let comment = "表情とリズムが見事にシンクロ。顔が完全に楽器になっていた！";
  if (face >= 85) {
    title = "顔面リミッター解除";
    comment = "その顔、反則級。AI審査員の表情認識が一瞬ひるんだ！";
  } else if (groove >= 85) {
    title = "鉄壁グルーヴマスター";
    comment = "変顔なのにビートはブレない。このギャップ、かなり強い！";
  } else if (variety >= 85) {
    title = "三味一体フェイス";
    comment = "口・笑顔・眉をフル活用。技の切り替えが鮮やか！";
  } else if (total < 52) {
    title = "伸びしろモンスター";
    comment = "まだ顔に余裕がある。恥を捨てた瞬間、スコアは跳ねる！";
  }
  return { total, groove, face, variety, power, title, comment, hits: hits.length };
}

class BeatAudio {
  context: AudioContext | null = null;
  master: GainNode | null = null;

  async start() {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.72;
      this.master.connect(this.context.destination);
    }
    await this.context.resume();
  }

  hit(type: Gesture, power = 0.8) {
    if (!this.context || !this.master) return;
    const ctx = this.context;
    const now = ctx.currentTime;
    if (type === "kick") {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.frequency.setValueAtTime(150, now);
      oscillator.frequency.exponentialRampToValueAtTime(42, now + 0.18);
      gain.gain.setValueAtTime(0.75 * power, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      oscillator.connect(gain).connect(this.master);
      oscillator.start(now); oscillator.stop(now + 0.26);
      return;
    }
    const length = type === "snare" ? 0.18 : 0.055;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * length), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    source.buffer = buffer;
    filter.type = type === "snare" ? "bandpass" : "highpass";
    filter.frequency.value = type === "snare" ? 1900 : 6500;
    gain.gain.setValueAtTime((type === "snare" ? 0.42 : 0.25) * power, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + length);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(now);
  }

  click(accent: boolean) {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.frequency.value = accent ? 1050 : 720;
    gain.gain.setValueAtTime(accent ? 0.14 : 0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now); oscillator.stop(now + 0.05);
  }
}

export function BeatBattle() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<FaceLandmarkerLike | null>(null);
  const rafRef = useRef(0);
  const audioRef = useRef(new BeatAudio());
  const phaseRef = useRef<Phase>("intro");
  const roundStartRef = useRef(0);
  const hitsRef = useRef<Hit[]>([]);
  const energyRef = useRef<number[]>([]);
  const gateRef = useRef<Record<Gesture, { high: boolean; at: number }>>({
    kick: { high: false, at: 0 }, snare: { high: false, at: 0 }, hat: { high: false, at: 0 },
  });
  const playerRef = useRef<1 | 2>(1);

  const [phase, setPhaseState] = useState<Phase>("intro");
  const [player, setPlayerState] = useState<1 | 2>(1);
  const [cameraStatus, setCameraStatus] = useState("カメラはまだOFF");
  const [tracked, setTracked] = useState(false);
  const [expression, setExpression] = useState<Expression>({ mouth: 0, smile: 0, brow: 0 });
  const [activeHit, setActiveHit] = useState<Gesture | null>(null);
  const [beat, setBeat] = useState(0);
  const [countdown, setCountdown] = useState(3);
  const [performances, setPerformances] = useState<Performance[]>([]);
  const [lastScore, setLastScore] = useState<Score | null>(null);
  const [error, setError] = useState("");

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const setPlayer = useCallback((next: 1 | 2) => {
    playerRef.current = next;
    setPlayerState(next);
  }, []);

  const triggerHit = useCallback((type: Gesture, power: number, manual = false) => {
    audioRef.current.hit(type, power);
    setActiveHit(type);
    window.setTimeout(() => setActiveHit((current) => current === type ? null : current), 120);
    if (phaseRef.current === "playing") {
      const at = performance.now() - roundStartRef.current;
      if (at >= 0 && at <= TOTAL_BEATS * BEAT_MS + 150) {
        hitsRef.current.push({ type, power: clamp(power), at, beat: Math.min(TOTAL_BEATS - 1, Math.floor(at / BEAT_MS)) });
      }
    } else if (manual) {
      setCameraStatus("練習OK。本番でその顔を叩き込もう！");
    }
  }, []);

  const processGesture = useCallback((type: Gesture, value: number, threshold: number) => {
    const now = performance.now();
    const gate = gateRef.current[type];
    const high = value >= threshold;
    if (high && !gate.high && now - gate.at > 150) {
      gate.at = now;
      triggerHit(type, value);
    }
    gate.high = high || value > threshold * 0.63;
  }, [triggerHit]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const map: Partial<Record<string, Gesture>> = { "1": "kick", "2": "snare", "3": "hat", z: "kick", x: "snare", c: "hat" };
      const type = map[event.key.toLowerCase()];
      if (type) triggerHit(type, 0.88, true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [triggerHit]);

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const faceLoop = useCallback(() => {
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    if (!video || !landmarker || !streamRef.current) return;
    if (video.readyState >= 2) {
      const result = landmarker.detectForVideo(video, performance.now());
      const shapes = result.faceBlendshapes?.[0]?.categories || [];
      const scores = Object.fromEntries(shapes.map((item) => [item.categoryName, item.score]));
      const hasFace = Boolean(result.faceLandmarks?.[0]?.length);
      setTracked(hasFace);
      if (hasFace) {
        const next = {
          mouth: scores.jawOpen || 0,
          smile: average([scores.mouthSmileLeft || 0, scores.mouthSmileRight || 0, scores.mouthStretchLeft || 0, scores.mouthStretchRight || 0]),
          brow: average([scores.browInnerUp || 0, scores.browOuterUpLeft || 0, scores.browOuterUpRight || 0]),
        };
        setExpression(next);
        const faceEnergy = Math.max(next.mouth, next.smile, next.brow);
        if (phaseRef.current === "playing") energyRef.current.push(faceEnergy);
        processGesture("kick", next.mouth, 0.52);
        processGesture("snare", next.smile, 0.28);
        processGesture("hat", next.brow, 0.32);
      }
    }
    rafRef.current = requestAnimationFrame(faceLoop);
  }, [processGesture]);

  const startCamera = useCallback(async () => {
    setError("");
    setCameraStatus("AIが顔を覚えています…");
    try {
      await audioRef.current.start();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } }, audio: false });
      streamRef.current = stream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      const vision = await import(/* @vite-ignore */ VISION_BUNDLE) as unknown as {
        FilesetResolver: { forVisionTasks: (path: string) => Promise<unknown> };
        FaceLandmarker: { createFromOptions: (files: unknown, options: unknown) => Promise<FaceLandmarkerLike> };
      };
      const files = await vision.FilesetResolver.forVisionTasks(VISION_WASM);
      landmarkerRef.current = await vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" }, runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true,
      });
      setCameraStatus("顔を検出中。3つの変顔を試してみよう");
      setPhase("camera");
      rafRef.current = requestAnimationFrame(faceLoop);
    } catch (reason) {
      console.error(reason);
      setError("カメラを開始できませんでした。許可を確認するか、1・2・3キーでデモできます。");
      setCameraStatus("キーボード・デモモード");
      setPhase("camera");
      await audioRef.current.start();
    }
  }, [faceLoop, setPhase]);

  const finishRound = useCallback(() => {
    const score = judgePerformance(hitsRef.current, energyRef.current);
    const performance: Performance = { player: playerRef.current, score, hits: [...hitsRef.current] };
    setPerformances((current) => [...current.filter((item) => item.player !== playerRef.current), performance]);
    setLastScore(score);
    setPhase("result");
    setBeat(0);
  }, [setPhase]);

  const startRound = useCallback(async () => {
    await audioRef.current.start();
    hitsRef.current = [];
    energyRef.current = [];
    gateRef.current = { kick: { high: false, at: 0 }, snare: { high: false, at: 0 }, hat: { high: false, at: 0 } };
    setCountdown(3);
    setPhase("ready");
    let count = 3;
    const countTimer = window.setInterval(() => {
      count -= 1;
      if (count > 0) {
        setCountdown(count);
        audioRef.current.click(count === 1);
      } else {
        window.clearInterval(countTimer);
        roundStartRef.current = performance.now();
        setBeat(1);
        setPhase("playing");
        audioRef.current.click(true);
        let currentBeat = 1;
        const beatTimer = window.setInterval(() => {
          currentBeat += 1;
          if (currentBeat > TOTAL_BEATS) {
            window.clearInterval(beatTimer);
            finishRound();
          } else {
            setBeat(currentBeat);
            audioRef.current.click((currentBeat - 1) % 4 === 0);
          }
        }, BEAT_MS);
      }
    }, 700);
  }, [finishRound, setPhase]);

  const nextPlayer = useCallback(() => {
    setPlayer(2);
    setLastScore(null);
    setPhase("camera");
  }, [setPhase, setPlayer]);

  const showFinal = useCallback(() => setPhase("final"), [setPhase]);

  const resetBattle = useCallback(() => {
    setPerformances([]);
    setLastScore(null);
    setPlayer(1);
    setPhase("camera");
  }, [setPhase, setPlayer]);

  const winner = useMemo(() => {
    if (performances.length < 2) return null;
    const sorted = [...performances].sort((a, b) => b.score.total - a.score.total);
    return sorted[0].score.total === sorted[1].score.total ? null : sorted[0];
  }, [performances]);

  const currentHits = phase === "playing" ? hitsRef.current.length : lastScore?.hits || 0;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="変顔BEAT対決 トップ"><span>変顔</span>BEAT対決<i>!</i></a>
        <div className="live-chip"><b className={tracked ? "online" : ""} /> AI FACE JUDGE <span>{tracked ? "LOCKED" : "STANDBY"}</span></div>
      </header>

      <section className="battle-stage" id="top">
        <div className="camera-card">
          <video ref={videoRef} className="camera-feed" playsInline muted />
          <div className={`camera-empty ${streamRef.current ? "hidden" : ""}`}><span>◉</span><p>FACE CAM</p></div>
          <div className="scan-lines" />
          <div className={`face-target ${tracked ? "tracked" : ""}`}><i /><i /><i /><i /></div>
          <div className="camera-label"><b className={tracked ? "online" : ""} /> {cameraStatus}</div>

          {phase === "intro" && (
            <div className="hero-overlay">
              <p className="kicker">YOUR FACE IS THE INSTRUMENT</p>
              <h1>変顔で、<br /><em>ビートを奪え。</em></h1>
              <p>口・笑顔・眉の3アクションで16ビートを自由に演奏。<br />AI審査員が、顔面とグルーヴを容赦なく採点。</p>
              <button className="primary-button" onClick={startCamera}>カメラを起動して対決 <span>→</span></button>
              <small>カメラ映像は端末内だけで処理され、保存されません</small>
            </div>
          )}

          {phase === "ready" && <div className="countdown"><small>PLAYER {player} — GET READY</small><strong>{countdown}</strong><span>顔面の準備はいい？</span></div>}

          {phase === "playing" && (
            <div className="playing-hud">
              <div><small>PLAYER {player}</small><strong>{Math.ceil(beat / 4)}<i>/4 BAR</i></strong></div>
              <div className="beat-flash">BEAT<br /><b>{((beat - 1) % 4) + 1}</b></div>
              <div><small>HITS</small><strong>{String(currentHits).padStart(2, "0")}</strong></div>
            </div>
          )}

          {(phase === "result" || phase === "final") && lastScore && (
            <div className="score-overlay">
              <small>AI JUDGE SCORE</small>
              <strong>{lastScore.total}</strong>
              <span>POINTS</span>
              <h2>{lastScore.title}</h2>
            </div>
          )}
        </div>

        <aside className="control-panel">
          <div className="round-header"><span>PLAYER</span><strong>{player}</strong><em>ROUND {player}/2</em></div>

          {(phase === "intro" || phase === "camera") && (
            <div className="gesture-list">
              <p className="panel-kicker">3 FACE ACTIONS</p>
              {(Object.keys(gestureInfo) as Gesture[]).map((type, index) => {
                const value = type === "kick" ? expression.mouth : type === "snare" ? expression.smile : expression.brow;
                return (
                  <button className={`gesture-row ${activeHit === type ? "hit" : ""}`} key={type} onClick={() => triggerHit(type, 0.9, true)}>
                    <span className={`face-icon face-${type}`} aria-hidden="true"><i /><b /></span>
                    <span><small>0{index + 1}</small><strong>{gestureInfo[type].label}</strong><em>{gestureInfo[type].face}</em></span>
                    <i className="meter"><b style={{ width: `${Math.round(value * 100)}%` }} /></i>
                  </button>
                );
              })}
              <p className="keyboard-note">カメラなし：<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> キーでも演奏</p>
              {error && <p className="error-note">{error}</p>}
              {phase === "camera" && <button className="primary-button full" onClick={startRound}>PLAYER {player} スタート <span>→</span></button>}
            </div>
          )}

          {phase === "playing" && (
            <div className="performance-panel">
              <p className="panel-kicker">FACE SIGNAL</p>
              <div className="signal-orb"><span className={activeHit ? `pulse ${activeHit}` : ""}>{activeHit ? gestureInfo[activeHit].label : "MAKE A FACE"}</span></div>
              <div className="step-track">{Array.from({ length: TOTAL_BEATS }, (_, index) => <i key={index} className={`${index < beat ? "past" : ""} ${index === beat - 1 ? "now" : ""}`} />)}</div>
              <p className="battle-tip">恥ずかしさを捨てろ。<br /><strong>大きい変顔ほど高得点。</strong></p>
            </div>
          )}

          {phase === "result" && lastScore && (
            <div className="result-panel">
              <p className="panel-kicker">AI SCORE BREAKDOWN</p>
              {([['グルーヴ', lastScore.groove], ['変顔力', lastScore.face], ['技の多彩さ', lastScore.variety], ['パワー', lastScore.power]] as [string, number][]).map(([label, value]) => (
                <div className="score-row" key={label}><span>{label}</span><i><b style={{ width: `${value}%` }} /></i><strong>{value}</strong></div>
              ))}
              <blockquote>「{lastScore.comment}」<cite>— AI FACE JUDGE</cite></blockquote>
              {player === 1 ? <button className="primary-button full" onClick={nextPlayer}>PLAYER 2 に交代 <span>→</span></button> : <button className="primary-button full" onClick={showFinal}>勝敗を見る <span>→</span></button>}
            </div>
          )}

          {phase === "final" && (
            <div className="final-panel">
              <p className="panel-kicker">FINAL RESULT</p>
              <h2>{winner ? `PLAYER ${winner.player} WIN!` : "DRAW GAME!"}</h2>
              <div className="versus-scores">
                {[1, 2].map((number) => { const item = performances.find((entry) => entry.player === number); return <div key={number} className={winner?.player === number ? "winner" : ""}><small>PLAYER {number}</small><strong>{item?.score.total ?? 0}</strong><span>{item?.score.title}</span></div>; })}
              </div>
              <p>{winner ? `今日いちばん顔でフロアを沸かせたのは PLAYER ${winner.player}！` : "顔面グルーヴは互角。もう一戦で決着だ！"}</p>
              <button className="primary-button full" onClick={resetBattle}>もう一度バトル <span>↻</span></button>
            </div>
          )}
        </aside>
      </section>

      <footer><span>HENGAO BEAT BATTLE — FACE-POWERED RHYTHM GAME</span><span>108 BPM / 16 BEATS / 2 PLAYERS</span></footer>
    </main>
  );
}
