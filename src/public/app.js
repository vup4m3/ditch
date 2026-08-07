"use strict";

const detectForm = document.getElementById("detect-form");
const pageUrlInput = document.getElementById("page-url");
const detectButton = document.getElementById("detect-button");
const detectStatus = document.getElementById("detect-status");
const candidatesSection = document.getElementById("candidates-section");
const candidatesList = document.getElementById("candidates-list");
const activeDownloadsSection = document.getElementById("active-downloads-section");
const activeDownloadsList = document.getElementById("active-downloads-list");
const historyBody = document.getElementById("history-body");

let currentDetectionId = null;

function setDetectStatus(text, isError) {
  detectStatus.hidden = !text;
  detectStatus.textContent = text;
  detectStatus.classList.toggle("error", !!isError);
}

function extensionFor(candidate) {
  if (candidate.type === "hls") return ".ts";
  if (candidate.type === "dash") return ".mp4";
  const match = /\.[a-zA-Z0-9]+$/.exec(candidate.url.split("?")[0]);
  return match ? match[0] : "";
}

function sanitizeForFilename(text) {
  return text.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function renderCandidate(candidate) {
  const li = document.createElement("li");
  li.className = "candidate-row";
  li.dataset.candidateId = candidate.id;

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${candidate.type.toUpperCase()}${candidate.label ? " · " + candidate.label : ""}`;
  li.appendChild(meta);

  if (candidate.drmProtected) {
    const badge = document.createElement("span");
    badge.className = "badge drm";
    badge.textContent = "無法下載（DRM 保護）";
    li.appendChild(badge);
  }

  const filenameInput = document.createElement("input");
  filenameInput.className = "filename-input";
  filenameInput.value = `candidate${extensionFor(candidate)}`;
  filenameInput.dataset.isDefault = "true";
  filenameInput.addEventListener("input", () => {
    filenameInput.dataset.isDefault = "false";
  });
  li.appendChild(filenameInput);

  const downloadButton = document.createElement("button");
  downloadButton.textContent = "下載";
  downloadButton.disabled = candidate.drmProtected;
  downloadButton.addEventListener("click", () => startDownload(candidate, filenameInput.value));
  li.appendChild(downloadButton);

  candidatesList.appendChild(li);
}

function backfillDefaultFilenames(pageTitle) {
  const rows = candidatesList.querySelectorAll(".candidate-row");
  for (const row of rows) {
    const input = row.querySelector(".filename-input");
    if (input.dataset.isDefault === "true") {
      const candidateId = row.dataset.candidateId;
      const ext = input.value.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? "";
      input.value = `${sanitizeForFilename(pageTitle) || "download"}${ext}`;
      input.dataset.isDefault = "true"; // still a default, just an updated one
      void candidateId;
    }
  }
}

detectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pageUrl = pageUrlInput.value.trim();
  if (!pageUrl) return;

  detectButton.disabled = true;
  candidatesList.innerHTML = "";
  candidatesSection.hidden = true;
  setDetectStatus("偵測中…（最多需要幾秒鐘）", false);

  try {
    const res = await fetch("/api/detections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageUrl }),
    });
    if (!res.ok) throw new Error(`偵測請求失敗 (HTTP ${res.status})`);
    const { id } = await res.json();
    currentDetectionId = id;
    candidatesSection.hidden = false;

    const source = new EventSource(`/api/detections/${id}/events`);
    source.addEventListener("candidate", (e) => {
      renderCandidate(JSON.parse(e.data));
    });
    source.addEventListener("done", (e) => {
      const data = JSON.parse(e.data);
      backfillDefaultFilenames(data.pageTitle || "");
      const count = candidatesList.children.length;
      setDetectStatus(count > 0 ? `偵測完成，找到 ${count} 個項目` : "偵測完成，沒有找到可下載的項目", count === 0);
      source.close();
      detectButton.disabled = false;
    });
    source.addEventListener("error", (e) => {
      const message = e.data ? JSON.parse(e.data).message : "連線中斷";
      setDetectStatus(`偵測失敗：${message}`, true);
      source.close();
      detectButton.disabled = false;
    });
  } catch (err) {
    setDetectStatus(`偵測失敗：${err.message}`, true);
    detectButton.disabled = false;
  }
});

function renderActiveDownload(jobId, filename) {
  const li = document.createElement("li");
  li.className = "active-download-row";
  li.dataset.jobId = jobId;

  const label = document.createElement("span");
  label.className = "meta";
  label.textContent = filename;
  li.appendChild(label);

  const bar = document.createElement("div");
  bar.className = "progress-bar";
  const fill = document.createElement("div");
  fill.style.width = "0%";
  bar.appendChild(fill);
  li.appendChild(bar);

  activeDownloadsSection.hidden = false;
  activeDownloadsList.appendChild(li);
  return { row: li, fill, label };
}

async function startDownload(candidate, filename) {
  if (!currentDetectionId) return;
  const res = await fetch("/api/downloads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ detectionId: currentDetectionId, candidateId: candidate.id, filename }),
  });
  if (!res.ok) {
    setDetectStatus(`建立下載任務失敗 (HTTP ${res.status})`, true);
    return;
  }
  const { id: jobId } = await res.json();
  const { row, fill, label } = renderActiveDownload(jobId, filename);

  const source = new EventSource(`/api/downloads/${jobId}/events`);
  source.addEventListener("progress", (e) => {
    const data = JSON.parse(e.data);
    const pct = data.totalSegments > 0 ? Math.round((data.completedSegments / data.totalSegments) * 100) : 0;
    fill.style.width = `${pct}%`;
  });
  source.addEventListener("moving", () => {
    fill.style.width = "100%";
    label.textContent = `${filename}（搬移到目的地中…）`;
  });
  source.addEventListener("done", () => {
    fill.style.width = "100%";
    source.close();
    row.remove();
    loadHistory();
  });
  source.addEventListener("error", () => {
    source.close();
    row.remove();
    loadHistory();
  });
}

function statusLabel(status) {
  return { pending: "等待中", downloading: "下載中", moving: "搬移到目的地中", completed: "已完成", failed: "失敗" }[status] || status;
}

async function loadHistory() {
  const res = await fetch("/api/downloads");
  if (!res.ok) return;
  const jobs = await res.json();

  historyBody.innerHTML = "";
  for (const job of jobs) {
    const tr = document.createElement("tr");

    const filenameCell = document.createElement("td");
    filenameCell.textContent = job.filename;
    tr.appendChild(filenameCell);

    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `status-badge ${job.status}`;
    badge.textContent = statusLabel(job.status);
    statusCell.appendChild(badge);
    tr.appendChild(statusCell);

    const progressCell = document.createElement("td");
    progressCell.textContent = `${Math.round(job.progress * 100)}%`;
    tr.appendChild(progressCell);

    const sourceCell = document.createElement("td");
    const sourceLink = document.createElement("a");
    sourceLink.href = job.sourcePageUrl;
    sourceLink.textContent = new URL(job.sourcePageUrl || "about:blank").hostname || job.sourcePageUrl;
    sourceLink.target = "_blank";
    sourceLink.rel = "noopener noreferrer";
    sourceCell.appendChild(sourceLink);
    tr.appendChild(sourceCell);

    const actionCell = document.createElement("td");
    if (job.status === "completed") {
      const link = document.createElement("a");
      link.href = `/api/downloads/${job.id}/file`;
      link.textContent = "下載檔案";
      actionCell.appendChild(link);
    } else if (job.status === "failed" && job.errorMessage) {
      actionCell.textContent = job.errorMessage;
    }
    tr.appendChild(actionCell);

    historyBody.appendChild(tr);
  }
}

loadHistory();
