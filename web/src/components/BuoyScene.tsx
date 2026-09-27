import { Suspense, useMemo, useRef } from "react";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import { ContactShadows, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { current, fromEuler, toWorld, type Sample } from "../motion";

// RAY.stl has its nose along +Y and Z up. Buoy axes are x forward, y left, z up;
// three.js is Y up, so buoy (x, y, z) -> three (x, z, -y), and STL (x, y, z) -> three (y, z, x).
// If the model's nose doesn't match the MPU's forward axis, rotate it here.
const MODEL_YAW_DEG = 0;
const G_TO_UNITS = 1.6; // arrow length per g of linear acceleration
const ARROW_BASE = new THREE.Vector3(0, 0.2, 0);

const b2t = (v: [number, number, number]) => new THREE.Vector3(v[0], v[2], -v[1]);
const q2t = (q: Sample["q"]) => new THREE.Quaternion(q[1], q[3], -q[2], q[0]);

export type Live = { sample: Sample | null; lin: number };

type Props = {
  node: string;
  fallback: { roll: number; pitch: number } | null; // tilt from the last reading when there's no live motion
  theme: "dark" | "light";
  onFrame?: (l: Live) => void;
};

export function BuoyScene(props: Props) {
  return (
    <Canvas camera={{ position: [1.75, 1.1, 1.9], fov: 36, near: 0.01, far: 50 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
      <hemisphereLight args={["#ffffff", "#0b3b3c", 0.9]} />
      <directionalLight position={[2, 4, 1.5]} intensity={1.6} />
      <directionalLight position={[-3, 1.5, -2]} intensity={0.5} color="#9ef0f0" />
      <Suspense fallback={<Rig {...props} model={<PlaceholderHull theme={props.theme} />} />}>
        <Rig {...props} model={<RayHull theme={props.theme} />} />
      </Suspense>
      <Water theme={props.theme} />
      <ContactShadows position={[0, -0.249, 0]} opacity={props.theme === "dark" ? 0.55 : 0.35} scale={3} blur={2.6} far={1} />
      <OrbitControls enablePan={false} minDistance={1} maxDistance={5} maxPolarAngle={Math.PI * 0.58} enableDamping />
    </Canvas>
  );
}

function Rig({ node, fallback, onFrame, model, theme }: Props & { model: React.ReactNode }) {
  const body = useRef<THREE.Group>(null);
  const arrow = useMemo(() => {
    // Solid shaft + cone along +Y, scaled to length; WebGL ignores line widths.
    const mat = new THREE.MeshStandardMaterial({ color: 0x08bdba, emissive: 0x08bdba, emissiveIntensity: 0.5 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 12).translate(0, 0.5, 0), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.09, 16).translate(0, 0.045, 0), mat);
    const g = new THREE.Group();
    g.add(shaft, head);
    g.position.copy(ARROW_BASE);
    return { g, shaft, head };
  }, []);
  const trail = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(60 * 3), 3));
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x08bdba, transparent: true, opacity: 0.45 }));
  }, []);
  const smooth = useRef(new THREE.Vector3());
  const tips = useRef<THREE.Vector3[]>([]);
  const lastReport = useRef(0);

  useFrame((_, dt) => {
    const s = current(node);
    const q = s ? s.q : fallback ? fromEuler(fallback.roll, fallback.pitch) : ([1, 0, 0, 0] as Sample["q"]);
    body.current?.quaternion.slerp(q2t(q), s ? 1 : Math.min(1, dt * 4));

    let lin = 0;
    if (s) {
      const w = toWorld(s.q, s.a);
      const v = b2t([w[0], w[1], w[2] - 1]); // gravity removed, world frame
      smooth.current.lerp(v, 0.3);
      lin = smooth.current.length();
    } else smooth.current.multiplyScalar(0.9);

    const len = smooth.current.length();
    const L = Math.min(1.4, 0.12 + len * G_TO_UNITS);
    arrow.g.visible = len > 0.012;
    if (arrow.g.visible) {
      arrow.g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), smooth.current.clone().normalize());
      arrow.shaft.scale.set(1, L - 0.09, 1);
      arrow.head.position.set(0, L - 0.09, 0);
    }
    const tip = arrow.g.visible ? smooth.current.clone().normalize().multiplyScalar(L).add(ARROW_BASE) : ARROW_BASE.clone();
    tips.current.push(tip);
    if (tips.current.length > 60) tips.current.shift();
    const pos = trail.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < 60; i++) {
      const p = tips.current[Math.max(0, tips.current.length - 60 + i)] ?? tip;
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;

    const now = performance.now();
    if (onFrame && now - lastReport.current > 100) {
      lastReport.current = now;
      onFrame({ sample: s, lin });
    }
  });

  return (
    <>
      <group ref={body}>
        <group rotation={[0, (MODEL_YAW_DEG * Math.PI) / 180, 0]}>{model}</group>
        <BodyAxes up={theme === "dark" ? 0xf4f4f4 : 0x161616} />
      </group>
      <primitive object={arrow.g} />
      <primitive object={trail} />
    </>
  );
}

function RayHull({ theme }: { theme: string }) {
  const stl = useLoader(STLLoader, "/models/ray.stl");
  const geom = useMemo(() => {
    const g = stl.clone();
    g.applyMatrix4(new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1));
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const size = new THREE.Vector3();
    bb.getSize(size);
    const s = 1 / Math.max(size.x, size.z);
    g.center();
    g.scale(s, s, s);
    g.computeVertexNormals();
    return g;
  }, [stl]);
  return (
    <mesh geometry={geom}>
      <meshStandardMaterial color={theme === "dark" ? "#d4d4d4" : "#b8b8b8"} metalness={0.25} roughness={0.45} side={THREE.DoubleSide} />
    </mesh>
  );
}

function PlaceholderHull({ theme }: { theme: string }) {
  return (
    <mesh scale={[1, 0.25, 0.8]}>
      <sphereGeometry args={[0.5, 32, 16]} />
      <meshStandardMaterial color={theme === "dark" ? "#6f6f6f" : "#a8a8a8"} wireframe />
    </mesh>
  );
}

/** Short body-frame axes: forward (x) and up (z), so tilt reads at a glance. */
function BodyAxes({ up }: { up: number }) {
  const lines = useMemo(() => {
    const mk = (to: THREE.Vector3, color: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
    };
    return [mk(new THREE.Vector3(0.72, 0, 0), 0xff832b), mk(new THREE.Vector3(0, 0.42, 0), up)];
  }, [up]);
  return (
    <>
      {lines.map((l, i) => (
        <primitive key={i} object={l} />
      ))}
    </>
  );
}

function Water({ theme }: { theme: string }) {
  const ring = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const r0 = 1.05, r1 = i % 9 === 0 ? 1.15 : 1.09;
      pts.push(new THREE.Vector3(Math.cos(a) * r0, 0, Math.sin(a) * r0), new THREE.Vector3(Math.cos(a) * r1, 0, Math.sin(a) * r1));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);
  const c = theme === "dark" ? "#08bdba" : "#007d79";
  return (
    <group position={[0, -0.25, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.05, 96]} />
        <meshBasicMaterial color={c} transparent opacity={theme === "dark" ? 0.06 : 0.08} />
      </mesh>
      <gridHelper args={[2.1, 21, c, c]} material-transparent material-opacity={0.12} />
      <lineSegments geometry={ring}>
        <lineBasicMaterial color={c} transparent opacity={0.5} />
      </lineSegments>
    </group>
  );
}
