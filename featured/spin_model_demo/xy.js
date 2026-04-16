const model = (() => {
  const TWO_PI = 2 * Math.PI;
  const latticeSize = 100;
  const spinCount = latticeSize * latticeSize;
  const cellSize = 3;
  const gap = 1;

  let temperature = 1.0;
  let algorithm = 0;
  let running = false;
  let timerID = 0;
  let baseTime = 0;
  let interval = 200;

  const canvas = document.getElementById("model");
  const context = canvas.getContext("2d");
  canvas.width = canvas.height = latticeSize * (cellSize + gap) - 1;

  let colorMap = colorHsv;
  let colorOffset = 0;
  let showVortex = true;
  let rotateColor = false;

  const spin = Array.from({ length: spinCount }, () => Math.random());
  const cluster = new Array(spinCount);
  const isFlip = new Array(spinCount);

  function colorBlue(value) {
    const channel = Math.floor(value * 255) % 256;
    return `rgb(${channel},${channel},255)`;
  }

  function colorHsv(value) {
    const h = value;
    const s = 0.5;
    const v = 1.0;
    const sector = Math.floor(h * 6);
    const f = h * 6 - sector;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    let r = 0;
    let g = 0;
    let b = 0;
    switch (sector % 6) {
      case 0:
        r = v;
        g = t;
        b = p;
        break;
      case 1:
        r = q;
        g = v;
        b = p;
        break;
      case 2:
        r = p;
        g = v;
        b = t;
        break;
      case 3:
        r = p;
        g = q;
        b = v;
        break;
      case 4:
        r = t;
        g = p;
        b = v;
        break;
      default:
        r = v;
        g = p;
        b = q;
        break;
    }

    return `rgb(${Math.floor(r * 255)},${Math.floor(g * 255)},${Math.floor(b * 255)})`;
  }

  function colorThreeBands(value) {
    return colorHsv(Math.floor(value * 3) / 3);
  }

  function drawSpinField() {
    for (let index = 0; index < spinCount; index += 1) {
      const x = index % latticeSize;
      const y = Math.floor(index / latticeSize);
      context.fillStyle = colorMap(spin[index] + colorOffset);
      context.fillRect(x * (cellSize + gap), y * (cellSize + gap), cellSize, cellSize);
    }
  }

  function spinDifference(a, b) {
    const difference = a - b;
    if (difference > 0.5) {
      return difference - 1;
    }
    if (difference < -0.5) {
      return difference + 1;
    }
    return difference;
  }

  function drawVortexField() {
    for (let index = 0; index < spinCount; index += 1) {
      const x = index % latticeSize;
      const y = Math.floor(index / latticeSize);
      if (x === latticeSize - 1 || y === latticeSize - 1) {
        continue;
      }

      const s0 = spin[index];
      const s1 = spin[(index + 1) % spinCount];
      const s2 = spin[(index + 1 + latticeSize) % spinCount];
      const s3 = spin[(index + latticeSize) % spinCount];
      let vortex = spinDifference(s1, s0);
      vortex += spinDifference(s2, s1);
      vortex += spinDifference(s3, s2);
      vortex += spinDifference(s0, s3);

      if (vortex > 0.5) {
        context.fillStyle = "rgba(255,0,0,0.5)";
        context.fillRect(x * (cellSize + gap), y * (cellSize + gap), cellSize + 4, cellSize + 4);
      } else if (vortex < -0.5) {
        context.fillStyle = "rgba(0,0,0,0.5)";
        context.fillRect(x * (cellSize + gap), y * (cellSize + gap), cellSize + 4, cellSize + 4);
      }
    }
  }

  function shiftColorMap() {
    colorOffset -= 1 / 64;
    if (colorOffset < 0) {
      colorOffset = 1;
    }
  }

  function draw() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawSpinField();
    if (showVortex) {
      drawVortexField();
    }
    if (rotateColor) {
      shiftColorMap();
    }
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min)) + min;
  }

  function heatBath() {
    interval = 40;
    for (let step = 0; step < spinCount; step += 1) {
      const index = randomInt(0, spinCount);
      const newSpin = Math.random();
      const angleNew = TWO_PI * newSpin;
      const angle0 = TWO_PI * spin[index];
      const angle1 = TWO_PI * spin[(index + 1) % spinCount];
      const angle2 = TWO_PI * spin[(index - 1 + spinCount) % spinCount];
      const angle3 = TWO_PI * spin[(index + latticeSize) % spinCount];
      const angle4 = TWO_PI * spin[(index - latticeSize + spinCount) % spinCount];
      let probability =
        Math.cos(angle0 - angle1) +
        Math.cos(angle0 - angle2) +
        Math.cos(angle0 - angle3) +
        Math.cos(angle0 - angle4);
      probability -=
        Math.cos(angleNew - angle1) +
        Math.cos(angleNew - angle2) +
        Math.cos(angleNew - angle3) +
        Math.cos(angleNew - angle4);
      probability = 1 / (1 + Math.exp(probability / temperature));
      if (Math.random() < probability) {
        spin[index] = newSpin;
      }
    }
  }

  function findRoot(index) {
    let child = index;
    let parent = cluster[child];
    while (child !== parent) {
      child = parent;
      parent = cluster[child];
    }
    return child;
  }

  function connect(a, b) {
    const rootA = findRoot(a);
    const rootB = findRoot(b);
    const root = rootA < rootB ? rootA : rootB;

    let child = a;
    while (child !== root) {
      const parent = cluster[child];
      cluster[child] = root;
      child = parent;
    }

    child = b;
    while (child !== root) {
      const parent = cluster[child];
      cluster[child] = root;
      child = parent;
    }
  }

  function isConnected(a, b, axis) {
    const spinA = TWO_PI * spin[a];
    const spinB = TWO_PI * spin[b];
    const axisAngle = TWO_PI * axis;
    const probability = 1 - Math.exp((-2 * Math.cos(spinA - axisAngle) * Math.cos(spinB - axisAngle)) / temperature);
    return Math.random() < probability;
  }

  function makeCluster(axis) {
    for (let index = 0; index < spinCount; index += 1) {
      cluster[index] = index;
    }
    for (let index = 0; index < spinCount; index += 1) {
      const right = (index + 1) % spinCount;
      if (isConnected(index, right, axis)) {
        connect(index, right);
      }
    }
    for (let index = 0; index < spinCount; index += 1) {
      const vertical = (index + latticeSize) % spinCount;
      if (isConnected(index, vertical, axis)) {
        connect(index, vertical);
      }
    }
    for (let index = 0; index < spinCount; index += 1) {
      cluster[index] = findRoot(index);
    }
  }

  function flippedSpin(index, axis) {
    let nextSpin = 2 * axis - spin[index] + 0.5;
    while (nextSpin > 1) {
      nextSpin -= 1;
    }
    while (nextSpin < 0) {
      nextSpin += 1;
    }
    return nextSpin;
  }

  function swendsenWang() {
    interval = 200;
    const axis = Math.random();
    makeCluster(axis);

    for (let index = 0; index < spinCount; index += 1) {
      isFlip[index] = Math.random() < 0.5;
    }

    for (let index = 0; index < spinCount; index += 1) {
      const root = cluster[index];
      if (isFlip[root]) {
        spin[index] = flippedSpin(index, axis);
      }
    }
  }

  function wolff() {
    interval = 200;
    const axis = Math.random();
    let count = 0;

    makeCluster(axis);
    while (count < spinCount / 5) {
      const targetCluster = cluster[randomInt(0, spinCount)];
      for (let index = 0; index < spinCount; index += 1) {
        if (cluster[index] === targetCluster) {
          spin[index] = flippedSpin(index, axis);
          count += 1;
        }
      }
    }
  }

  function updateSpin() {
    if (algorithm === 0) {
      heatBath();
    } else if (algorithm === 1) {
      swendsenWang();
    } else {
      wolff();
    }
  }

  function update() {
    updateSpin();
    draw();
  }

  function loop() {
    const now = Date.now();
    if (now - baseTime > interval) {
      baseTime = now;
      update();
    }
    timerID = requestAnimationFrame(loop);
  }

  return {
    start() {
      draw();
      if (!running) {
        loop();
      }
      running = true;
    },
    stop() {
      cancelAnimationFrame(timerID);
      running = false;
    },
    step() {
      cancelAnimationFrame(timerID);
      running = false;
      update();
    },
    setTemperature(value) {
      temperature = value;
    },
    setAlgorithm(value) {
      algorithm = value;
    },
    setColorMode(value) {
      if (value === 0) {
        colorMap = colorHsv;
      } else if (value === 1) {
        colorMap = colorBlue;
      } else {
        colorMap = colorThreeBands;
      }
      draw();
    },
    toggleVortex() {
      showVortex = !showVortex;
      draw();
      return showVortex;
    },
    toggleColorRotation() {
      rotateColor = !rotateColor;
      return rotateColor;
    }
  };
})();

function setToggleState(button, active) {
  button.classList.toggle("is-active", active);
  button.setAttribute("aria-pressed", String(active));
}

window.addEventListener("DOMContentLoaded", () => {
  const startButton = document.getElementById("start");
  const stopButton = document.getElementById("stop");
  const stepButton = document.getElementById("step");
  const algorithmSelect = document.getElementById("algorithm");
  const colorSelect = document.getElementById("color");
  const temperatureSlider = document.getElementById("temperature");
  const temperatureValue = document.getElementById("temperature_value");
  const vortexButton = document.getElementById("show_vortex");
  const colorButton = document.getElementById("rotate_color");

  const updateTemperature = (value) => {
    const temperature = Number(value);
    temperatureValue.textContent = temperature.toFixed(2);
    temperatureSlider.value = String(temperature);
    model.setTemperature(temperature);
  };

  const setRunningState = (running) => {
    startButton.classList.toggle("is-primary", running);
    stopButton.classList.toggle("is-primary", !running);
    stepButton.classList.remove("is-primary");
  };

  startButton.addEventListener("click", () => {
    model.start();
    setRunningState(true);
  });

  stopButton.addEventListener("click", () => {
    model.stop();
    setRunningState(false);
  });

  stepButton.addEventListener("click", () => {
    model.step();
    setRunningState(false);
    stepButton.classList.add("is-primary");
    setTimeout(() => stepButton.classList.remove("is-primary"), 180);
  });

  algorithmSelect.addEventListener("change", (event) => {
    model.setAlgorithm(Number(event.target.value));
  });

  colorSelect.addEventListener("change", (event) => {
    model.setColorMode(Number(event.target.value));
  });

  temperatureSlider.addEventListener("input", (event) => {
    updateTemperature(event.target.value);
  });

  vortexButton.addEventListener("click", () => {
    const active = model.toggleVortex();
    setToggleState(vortexButton, active);
  });

  colorButton.addEventListener("click", () => {
    const active = model.toggleColorRotation();
    setToggleState(colorButton, active);
  });

  algorithmSelect.value = "0";
  colorSelect.value = "0";
  updateTemperature(0.5);
  setToggleState(vortexButton, true);
  setToggleState(colorButton, false);
  model.start();
  setRunningState(true);
});
