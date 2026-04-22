/**
 * 통합 배치도 — 진입점 (구현은 ./global-layout/ 모듈에 분리)
 */
import "./shared/pwa-update-reload.js";
import { startGlobalLayoutApp } from "./global-layout/app.js";

startGlobalLayoutApp();
