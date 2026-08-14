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
const selectAllCheckbox = document.getElementById("select-all-checkbox");
const deleteSelectedButton = document.getElementById("delete-selected-button");

const settingsForm = document.getElementById("settings-form");
const concurrencyLimitInput = document.getElementById("concurrency-limit-input");
const settingsStatus = document.getElementById("settings-status");

const folderModalOverlay = document.getElementById("folder-modal-overlay");
const folderBreadcrumb = document.getElementById("folder-breadcrumb");
const folderModalStatus = document.getElementById("folder-modal-status");
const folderList = document.getElementById("folder-list");
const newFolderForm = document.getElementById("new-folder-form");
const newFolderNameInput = document.getElementById("new-folder-name");
const folderModalCancel = document.getElementById("folder-modal-cancel");
const folderModalConfirm = document.getElementById("folder-modal-confirm");

const LAST_DESTINATION_FOLDER_KEY = "ditch:lastDestinationFolder";

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

  // Placeholder box until (if ever) the Detection Session's shared thumbnail loads — it isn't
  // ready until detection finishes, so the src is only set once "done" fires (ADR-0011).
  const thumbnailWrap = document.createElement("span");
  thumbnailWrap.className = "thumbnail-wrap";
  const thumbnail = document.createElement("img");
  thumbnail.className = "thumbnail";
  thumbnail.alt = "";
  thumbnail.hidden = true;
  thumbnail.addEventListener("load", () => {
    thumbnail.hidden = false;
  });
  thumbnailWrap.appendChild(thumbnail);
  li.appendChild(thumbnailWrap);

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
  downloadButton.addEventListener("click", () => openFolderModal(candidate, filenameInput.value));
  li.appendChild(downloadButton);

  candidatesList.appendChild(li);
}

function applyThumbnails(detectionId) {
  const src = `/api/detections/${detectionId}/thumbnail`;
  for (const img of candidatesList.querySelectorAll("img.thumbnail")) {
    img.src = src;
  }
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

function setSettingsStatus(text, isError) {
  settingsStatus.hidden = !text;
  settingsStatus.textContent = text;
  settingsStatus.classList.toggle("error", !!isError);
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { concurrencyLimit } = await res.json();
    concurrencyLimitInput.value = concurrencyLimit;
  } catch (err) {
    setSettingsStatus(`載入設定失敗：${err.message}`, true);
  }
}

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ concurrencyLimit: Number(concurrencyLimitInput.value) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { concurrencyLimit } = await res.json();
    concurrencyLimitInput.value = concurrencyLimit;
    setSettingsStatus("已儲存", false);
  } catch (err) {
    setSettingsStatus(`儲存失敗：${err.message}`, true);
  }
});

loadSettings();

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
      applyThumbnails(id);
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

function queuedLabel(filename, position) {
  return position ? `${filename}（排隊中，第 ${position} 位）` : `${filename}（排隊中）`;
}

function renderActiveDownload(jobId, filename, initialStatus, queuePosition) {
  const li = document.createElement("li");
  li.className = "active-download-row";
  li.dataset.jobId = jobId;

  const label = document.createElement("span");
  label.className = "meta";
  label.textContent = initialStatus === "queued" ? queuedLabel(filename, queuePosition) : filename;
  li.appendChild(label);

  const bar = document.createElement("div");
  bar.className = "progress-bar";
  const fill = document.createElement("div");
  fill.style.width = "0%";
  bar.appendChild(fill);
  li.appendChild(bar);

  // Only a still-queued job can be cancelled (ADR-0009) — hidden once it starts downloading.
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "secondary";
  cancelButton.textContent = "取消";
  cancelButton.hidden = initialStatus !== "queued";
  li.appendChild(cancelButton);

  activeDownloadsSection.hidden = false;
  activeDownloadsList.appendChild(li);
  return { row: li, fill, label, cancelButton };
}

let folderModalState = null;

function joinFolderPath(parent, child) {
  return parent ? `${parent}/${child}` : child;
}

function openFolderModal(candidate, filename) {
  folderModalState = { candidate, filename, currentPath: localStorage.getItem(LAST_DESTINATION_FOLDER_KEY) || "" };
  folderModalOverlay.hidden = false;
  newFolderNameInput.value = "";
  loadFolderLevel(folderModalState.currentPath);
}

function closeFolderModal() {
  folderModalOverlay.hidden = true;
  folderModalState = null;
}

function setFolderModalStatus(text, isError) {
  folderModalStatus.hidden = !text;
  folderModalStatus.textContent = text;
  folderModalStatus.classList.toggle("error", !!isError);
}

function renderBreadcrumb(path) {
  folderBreadcrumb.innerHTML = "";
  const segments = path ? path.split("/") : [];

  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.textContent = "（根目錄）";
  rootButton.disabled = segments.length === 0;
  rootButton.addEventListener("click", () => loadFolderLevel(""));
  folderBreadcrumb.appendChild(rootButton);

  let builtPath = "";
  segments.forEach((segment, index) => {
    builtPath = joinFolderPath(builtPath, segment);
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "/";
    folderBreadcrumb.appendChild(sep);

    const targetPath = builtPath;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = segment;
    button.disabled = index === segments.length - 1;
    button.addEventListener("click", () => loadFolderLevel(targetPath));
    folderBreadcrumb.appendChild(button);
  });
}

function renderFolderList(folders, currentPath) {
  folderList.innerHTML = "";
  if (folders.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "沒有子資料夾";
    folderList.appendChild(li);
    return;
  }
  for (const name of folders) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `📁 ${name}`;
    button.addEventListener("click", () => loadFolderLevel(joinFolderPath(currentPath, name)));
    li.appendChild(button);
    folderList.appendChild(li);
  }
}

async function loadFolderLevel(path) {
  setFolderModalStatus("載入中…", false);
  try {
    const res = await fetch(`/api/folders?path=${encodeURIComponent(path)}`);
    if (res.status === 404 && path !== "") {
      await loadFolderLevel("");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { folders } = await res.json();
    folderModalState.currentPath = path;
    setFolderModalStatus("", false);
    renderBreadcrumb(path);
    renderFolderList(folders, path);
  } catch (err) {
    setFolderModalStatus(`載入資料夾失敗：${err.message}`, true);
  }
}

newFolderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = newFolderNameInput.value.trim();
  if (!folderModalState) return;
  if (!name) {
    setFolderModalStatus("請先輸入新資料夾名稱", true);
    newFolderNameInput.focus();
    return;
  }

  try {
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: folderModalState.currentPath, name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    newFolderNameInput.value = "";
    await loadFolderLevel(folderModalState.currentPath);
  } catch (err) {
    setFolderModalStatus(`新增資料夾失敗：${err.message}`, true);
  }
});

folderModalCancel.addEventListener("click", () => closeFolderModal());

folderModalConfirm.addEventListener("click", () => {
  if (!folderModalState) return;
  const { candidate, filename, currentPath } = folderModalState;
  localStorage.setItem(LAST_DESTINATION_FOLDER_KEY, currentPath);
  closeFolderModal();
  startDownload(candidate, filename, currentPath);
});

async function startDownload(candidate, filename, destinationFolder = "", overwrite = false) {
  if (!currentDetectionId) return;
  const res = await fetch("/api/downloads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      detectionId: currentDetectionId,
      candidateId: candidate.id,
      filename,
      destinationFolder,
      overwrite,
    }),
  });
  if (res.status === 409) {
    const { filename: conflictFilename } = await res.json();
    if (confirm(`已有名為「${conflictFilename}」的檔案，要覆蓋嗎？`)) {
      await startDownload(candidate, filename, destinationFolder, true);
    }
    return;
  }
  if (!res.ok) {
    setDetectStatus(`建立下載任務失敗 (HTTP ${res.status})`, true);
    return;
  }
  const { id: jobId, status, queuePosition } = await res.json();
  const { row, fill, label, cancelButton } = renderActiveDownload(jobId, filename, status, queuePosition);

  const source = new EventSource(`/api/downloads/${jobId}/events`);

  cancelButton.addEventListener("click", async () => {
    cancelButton.disabled = true;
    const cancelRes = await fetch(`/api/downloads/${jobId}`, { method: "DELETE" });
    if (cancelRes.ok) {
      source.close();
      row.remove();
      loadHistory();
    } else {
      cancelButton.disabled = false;
    }
  });

  source.addEventListener("queued", (e) => {
    label.textContent = queuedLabel(filename, JSON.parse(e.data).position);
  });
  source.addEventListener("progress", (e) => {
    cancelButton.hidden = true; // no longer queued — it's running now, can't be cancelled (ADR-0009)
    label.textContent = filename;
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
  source.addEventListener("cancelled", () => {
    source.close();
    row.remove();
    loadHistory();
  });
}

function statusLabel(status) {
  return (
    {
      queued: "排隊中",
      pending: "等待中",
      downloading: "下載中",
      moving: "搬移到目的地中",
      completed: "已完成",
      failed: "失敗",
      cancelled: "已取消",
    }[status] || status
  );
}

// A record can only be deleted once it's done — same terminal states "cancel" hands off to
// "delete" for (ADR-0010). Jobs still occupying an execution slot get no checkbox at all.
const DELETABLE_STATUSES = ["completed", "failed", "cancelled"];
const selectedJobIds = new Set();

function isDeletable(status) {
  return DELETABLE_STATUSES.includes(status);
}

async function deleteJobs(ids) {
  await Promise.all(ids.map((id) => fetch(`/api/downloads/${id}`, { method: "DELETE" })));
  for (const id of ids) selectedJobIds.delete(id);
  loadHistory();
}

function updateBatchButtonState() {
  const count = selectedJobIds.size;
  deleteSelectedButton.disabled = count === 0;
  deleteSelectedButton.textContent = count > 0 ? `刪除選取項目 (${count})` : "刪除選取項目";
}

function updateSelectAllCheckbox(deletableCount) {
  selectAllCheckbox.checked = deletableCount > 0 && selectedJobIds.size === deletableCount;
  selectAllCheckbox.indeterminate = selectedJobIds.size > 0 && selectedJobIds.size < deletableCount;
}

selectAllCheckbox.addEventListener("change", () => {
  for (const checkbox of historyBody.querySelectorAll("input[type=checkbox][data-job-id]")) {
    checkbox.checked = selectAllCheckbox.checked;
    if (selectAllCheckbox.checked) selectedJobIds.add(checkbox.dataset.jobId);
    else selectedJobIds.delete(checkbox.dataset.jobId);
  }
  updateBatchButtonState();
});

deleteSelectedButton.addEventListener("click", async () => {
  const ids = [...selectedJobIds];
  if (ids.length === 0) return;
  if (ids.length >= 2 && !confirm(`確定要刪除 ${ids.length} 筆紀錄嗎？`)) return;
  await deleteJobs(ids);
});

async function loadHistory() {
  const res = await fetch("/api/downloads");
  if (!res.ok) return;
  const jobs = await res.json();

  const currentDeletableIds = new Set(jobs.filter((job) => isDeletable(job.status)).map((job) => job.id));
  for (const id of [...selectedJobIds]) {
    if (!currentDeletableIds.has(id)) selectedJobIds.delete(id);
  }

  historyBody.innerHTML = "";
  for (const job of jobs) {
    const tr = document.createElement("tr");

    const checkboxCell = document.createElement("td");
    if (isDeletable(job.status)) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.jobId = job.id;
      checkbox.checked = selectedJobIds.has(job.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedJobIds.add(job.id);
        else selectedJobIds.delete(job.id);
        updateBatchButtonState();
        updateSelectAllCheckbox(currentDeletableIds.size);
      });
      checkboxCell.appendChild(checkbox);
    }
    tr.appendChild(checkboxCell);

    const filenameCell = document.createElement("td");
    filenameCell.textContent = job.filename;
    tr.appendChild(filenameCell);

    const folderCell = document.createElement("td");
    folderCell.textContent = job.destinationFolder || "-";
    tr.appendChild(folderCell);

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
      const errorText = document.createElement("span");
      errorText.textContent = job.errorMessage;
      actionCell.appendChild(errorText);
    }
    if (isDeletable(job.status)) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "secondary";
      deleteButton.textContent = "刪除";
      deleteButton.addEventListener("click", () => deleteJobs([job.id]));
      actionCell.appendChild(deleteButton);
    }
    tr.appendChild(actionCell);

    historyBody.appendChild(tr);
  }

  updateBatchButtonState();
  updateSelectAllCheckbox(currentDeletableIds.size);
}

loadHistory();
