import * as THREE from "three";
import type { VoiceSessionState } from "../types";

type RobotMood = VoiceSessionState;

export class RobotScene {
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly clock = new THREE.Clock();
  private readonly robot = new THREE.Group();
  private readonly eyes: THREE.Mesh[] = [];
  private readonly antennas: THREE.Mesh[] = [];
  private frameId = 0;
  private mood: RobotMood = "idle";
  private disposed = false;

  constructor(private readonly mountNode: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.mountNode.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    this.camera.position.set(0, 0.5, 8.5);

    this.setupScene();
    this.resize();
    window.addEventListener("resize", this.resize);
    this.animate();
  }

  setMood(nextMood: RobotMood): void {
    this.mood = nextMood;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
    if (this.mountNode.contains(this.renderer.domElement)) {
      this.mountNode.removeChild(this.renderer.domElement);
    }
  }

  private setupScene(): void {
    this.scene.background = null;

    const ambient = new THREE.AmbientLight("#89b9ff", 1.8);
    const key = new THREE.DirectionalLight("#f5f2db", 1.6);
    key.position.set(4, 6, 6);
    const rim = new THREE.PointLight("#74f3ff", 18, 40, 2);
    rim.position.set(-5, 4, 4);
    this.scene.add(ambient, key, rim);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(4.2, 48),
      new THREE.MeshStandardMaterial({
        color: "#103044",
        transparent: true,
        opacity: 0.58,
        roughness: 0.9,
        metalness: 0.1
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.35;
    this.scene.add(floor);

    this.buildRobot();
    this.scene.add(this.robot);
  }

  private buildRobot(): void {
    const shellMaterial = new THREE.MeshStandardMaterial({
      color: "#dce8ff",
      metalness: 0.55,
      roughness: 0.25
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: "#17344b",
      metalness: 0.4,
      roughness: 0.55
    });
    const glowMaterial = new THREE.MeshStandardMaterial({
      color: "#8af4ff",
      emissive: "#64d9ff",
      emissiveIntensity: 1.1,
      metalness: 0.2,
      roughness: 0.3
    });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(1.15, 1.9, 10, 18), shellMaterial);
    torso.position.y = -0.15;
    this.robot.add(torso);

    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.1, 18), glowMaterial);
    core.rotation.z = Math.PI / 2;
    core.position.set(0, -0.1, 1.03);
    this.robot.add(core);

    const head = new THREE.Mesh(new THREE.SphereGeometry(1.12, 32, 32), shellMaterial);
    head.position.y = 2.05;
    this.robot.add(head);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.62, 0.4), darkMaterial);
    visor.position.set(0, 2.02, 0.86);
    this.robot.add(visor);

    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.16, 0.12), glowMaterial);
    mouth.position.set(0, 1.47, 1.02);
    this.robot.add(mouth);

    for (const offset of [-0.42, 0.42]) {
      const eye = new THREE.Mesh(new THREE.CircleGeometry(0.12, 24), glowMaterial.clone());
      eye.position.set(offset, 2.08, 1.06);
      this.eyes.push(eye);
      this.robot.add(eye);
    }

    for (const offset of [-0.52, 0.52]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.23, 1.45, 8, 12), shellMaterial);
      arm.position.set(offset * 3.2, 0.25, 0);
      arm.rotation.z = offset < 0 ? 0.35 : -0.35;
      this.robot.add(arm);
    }

    for (const offset of [-0.45, 0.45]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 1.35, 8, 12), darkMaterial);
      leg.position.set(offset, -2.15, 0);
      this.robot.add(leg);
    }

    for (const offset of [-0.32, 0.32]) {
      const antenna = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.65, 4, 10), glowMaterial.clone());
      antenna.position.set(offset, 3.15, 0.1);
      antenna.rotation.z = offset < 0 ? -0.15 : 0.15;
      this.antennas.push(antenna);
      this.robot.add(antenna);
    }
  }

  private resize = (): void => {
    const width = this.mountNode.clientWidth;
    const height = Math.max(this.mountNode.clientHeight, 320);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private animate = (): void => {
    if (this.disposed) {
      return;
    }

    const elapsed = this.clock.getElapsedTime();
    const breath = Math.sin(elapsed * 1.6) * 0.04;
    const wave = Math.sin(elapsed * 1.2) * 0.1;

    this.robot.position.y = breath * 2;
    this.robot.rotation.y = wave * 0.45;
    this.robot.rotation.x = Math.sin(elapsed * 0.7) * 0.03;

    const eyeIntensity =
      this.mood === "speaking" ? 2.4 :
      this.mood === "listening" ? 1.9 :
      this.mood === "processing" ? 1.5 :
      this.mood === "error" ? 0.6 :
      1.1;

    this.eyes.forEach((eye, index) => {
      const material = eye.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = eyeIntensity + Math.sin(elapsed * 6 + index) * 0.25;
      eye.scale.setScalar(this.mood === "speaking" ? 1 + Math.sin(elapsed * 12 + index) * 0.18 : 1);
    });

    this.antennas.forEach((antenna, index) => {
      antenna.rotation.x = Math.sin(elapsed * 2.1 + index) * 0.12;
      antenna.rotation.z = (index === 0 ? -1 : 1) * (0.15 + Math.sin(elapsed * 3.2 + index) * 0.08);
    });

    this.renderer.render(this.scene, this.camera);
    this.frameId = requestAnimationFrame(this.animate);
  };
}
