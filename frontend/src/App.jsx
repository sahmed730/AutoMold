import React, { useState, useRef, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Center, Environment } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';
import axios from 'axios';
import { UploadCloud, Box, Layers, Play, CheckCircle, XCircle, AlertTriangle, Settings, Sparkles } from 'lucide-react';
import './App.css';

function Model({ url, color = "#3b82f6", opacity = 1.0, transparent = false, position = [0, 0, 0], wireframe = false, rotation = [0, 0, 0] }) {
  const [geometry, setGeometry] = useState(null);

  useEffect(() => {
    if (!url) return;
    const loader = new STLLoader();
    loader.load(url, (geo) => {
      setGeometry(geo);
    });
  }, [url]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} position={position} rotation={rotation}>
      <meshStandardMaterial 
        color={color} 
        metalness={0.5} 
        roughness={0.2} 
        transparent={transparent}
        opacity={opacity}
        wireframe={wireframe}
      />
    </mesh>
  );
}

function App() {
  const [file, setFile] = useState(null);
  const [fileUrl, setFileUrl] = useState(null);
  const [processedUrl, setProcessedUrl] = useState(null);
  const [autoOrient, setAutoOrient] = useState(false);
  
  const [rotX, setRotX] = useState(0);
  const [rotY, setRotY] = useState(0);
  const [rotZ, setRotZ] = useState(0);

  const [loading, setLoading] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  
  const [zSplit, setZSplit] = useState(0);
  
  const [moldParts, setMoldParts] = useState(null); // { core_url, cavity_url, undercut_url, undercut_count }
  const [viewMode, setViewMode] = useState('part'); // 'part', 'mold', 'exploded', 'undercuts'
  
  const [aiAdvice, setAiAdvice] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  
  const [wireframe, setWireframe] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [explodeDist, setExplodeDist] = useState(0.8);
  
  const [material, setMaterial] = useState("ABS");
  const [productionVolume, setProductionVolume] = useState(10000);
  
  const fileInputRef = useRef(null);

  const activeUrl = processedUrl || fileUrl;

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile && selectedFile.name.toLowerCase().endsWith('.stl')) {
      setFile(selectedFile);
      setFileUrl(URL.createObjectURL(selectedFile));
      setProcessedUrl(null);
      setResults(null);
      setMoldParts(null);
      setViewMode('part');
      setError(null);
      setAiAdvice(null);
      setRotX(0);
      setRotY(0);
      setRotZ(0);
    } else {
      setError("Please select a valid STL file.");
    }
  };

  const handleAnalyze = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("auto_orient", autoOrient);
    formData.append("rot_x", rotX);
    formData.append("rot_y", rotY);
    formData.append("rot_z", rotZ);

    try {
      const response = await axios.post("http://127.0.0.1:8000/api/analyze", formData);
      if (response.data.error) {
        setError(response.data.error);
      } else {
        setResults(response.data);
        if (response.data.processed_url) {
          setProcessedUrl(response.data.processed_url);
        }
        // Set default split plane to middle of bounds
        const midZ = (response.data.bounding_box[0][2] + response.data.bounding_box[1][2]) / 2;
        setZSplit(midZ);
      }
    } catch (err) {
      setError("Failed to connect to the backend. Ensure it is running.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSplit = async () => {
    if (!file) return;
    setSplitting(true);
    setError(null);
    
    const formData = new FormData();
    formData.append("file", file);
    formData.append("z_split", zSplit);
    formData.append("auto_orient", autoOrient);
    formData.append("rot_x", rotX);
    formData.append("rot_y", rotY);
    formData.append("rot_z", rotZ);

    try {
      const response = await axios.post("http://127.0.0.1:8000/api/split", formData);
      if (response.data.error) {
        setError(response.data.error);
      } else {
        setMoldParts({
          core_url: response.data.core_url,
          cavity_url: response.data.cavity_url,
          cooling_url: response.data.cooling_url,
          undercut_url: response.data.undercut_url,
          undercut_count: response.data.undercut_count
        });
        setViewMode('exploded');
      }
    } catch (err) {
      setError("Failed to generate mold split.");
      console.error(err);
    } finally {
      setSplitting(false);
    }
  };

  const handleAskAI = async () => {
    if (!results) return;
    setAiLoading(true);
    setAiAdvice("");
    const formData = new FormData();
    formData.append("volume", results.volume || 0);
    formData.append("extents_x", results.extents[0]);
    formData.append("extents_y", results.extents[1]);
    formData.append("extents_z", results.extents[2]);
    formData.append("faces", results.faces);
    formData.append("draft_warning_pct", results.draft_warning_pct || 0);
    formData.append("undercut_count", moldParts ? moldParts.undercut_count : 0);
    formData.append("material", material);
    formData.append("production_volume", productionVolume);

    try {
      const response = await fetch("http://127.0.0.1:8000/api/ai-advisor", {
        method: "POST",
        body: formData
      });
      
      if (!response.ok) {
         setAiAdvice("Error: Backend returned " + response.status);
         setAiLoading(false);
         return;
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      setAiLoading(false);
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setAiAdvice(prev => prev + chunk);
      }
    } catch (err) {
      setAiAdvice("Failed to reach AI Engine.");
      console.error(err);
      setAiLoading(false);
    }
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1>AutoMold <span className="badge">AI Engine v2</span></h1>
        <p>Intelligent Mold Design & Analysis</p>
      </header>

      <main className="main-content">
        <div className="sidebar">
          <div className="card upload-card">
            <h2>1. Upload Model</h2>
            <div 
              className="drop-zone" 
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadCloud size={48} className="icon-upload" />
              <p>{file ? file.name : "Click or drag STL file here"}</p>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                accept=".stl" 
                style={{ display: 'none' }} 
              />
            </div>

            <div className="settings-row" style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input 
                type="checkbox" 
                id="autoOrient" 
                checked={autoOrient} 
                onChange={(e) => {
                  setAutoOrient(e.target.checked);
                  setResults(null);
                  setMoldParts(null);
                }} 
              />
              <label htmlFor="autoOrient" style={{ fontSize: '0.9rem', color: '#cbd5e1' }}>Auto-orient to minimize undercuts</label>
            </div>

            {!autoOrient && (
              <div style={{ marginTop: '1rem', background: 'rgba(255,255,255,0.03)', padding: '0.8rem', borderRadius: '8px' }}>
                <h4 style={{ fontSize: '0.85rem', color: '#cbd5e1', marginBottom: '0.5rem' }}>Manual Orientation Match</h4>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="action-button secondary" style={{marginTop: 0, padding: '0.5rem'}} onClick={() => { setRotX(x => (x + 90) % 360); setResults(null); }}>X 90°</button>
                  <button className="action-button secondary" style={{marginTop: 0, padding: '0.5rem'}} onClick={() => { setRotY(y => (y + 90) % 360); setResults(null); }}>Y 90°</button>
                  <button className="action-button secondary" style={{marginTop: 0, padding: '0.5rem'}} onClick={() => { setRotZ(z => (z + 90) % 360); setResults(null); }}>Z 90°</button>
                </div>
              </div>
            )}
            
            <button 
              className="action-button primary" 
              disabled={!file || loading || splitting}
              onClick={handleAnalyze}
            >
              {loading ? "Analyzing..." : "Analyze Geometry"}
              {!loading && <Play size={18} />}
            </button>
            {error && <div className="error-message">{error}</div>}
          </div>

          {results && (
            <div className="card results-card fade-in">
              <h2>2. Design Parting Line</h2>
              
              <div className="slider-container" style={{ margin: '1rem 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <label className="label">Z-Plane Height (Parting Line)</label>
                  <span className="value" style={{ fontFamily: 'monospace' }}>{zSplit.toFixed(2)} mm</span>
                </div>
                <input 
                  type="range" 
                  min={results.bounding_box[0][2]} 
                  max={results.bounding_box[1][2]} 
                  step="0.1" 
                  value={zSplit}
                  onChange={(e) => setZSplit(parseFloat(e.target.value))}
                  style={{ width: '100%', cursor: 'pointer' }}
                />
              </div>

              {!moldParts ? (
                <button 
                  className="action-button secondary"
                  onClick={handleSplit}
                  disabled={splitting}
                >
                  <Layers size={18} />
                  {splitting ? "Generating Tooling..." : "Generate Core, Cavity & Pins"}
                </button>
              ) : (
                <div className="view-controls">
                   {moldParts.undercut_count > 0 && (
                     <div className="error-message" style={{ background: 'rgba(245, 158, 11, 0.1)', borderColor: 'rgba(245, 158, 11, 0.3)', color: '#fcd34d', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                       <AlertTriangle size={16} /> 
                       Warning: {moldParts.undercut_count} undercut faces detected.
                     </div>
                   )}
                   
                   <h3 style={{marginTop: '1.5rem', marginBottom: '0.5rem', fontSize: '0.95rem', color: '#cbd5e1'}}>View Mode</h3>
                   <div style={{display: 'flex', flexWrap: 'wrap', gap: '0.5rem'}}>
                      <button 
                        className={`action-button ${viewMode === 'part' ? 'primary' : 'secondary'}`}
                        style={{marginTop: 0, padding: '0.5rem', flex: '1 1 40%'}}
                        onClick={() => setViewMode('part')}
                      >
                        Part
                      </button>
                      <button 
                        className={`action-button ${viewMode === 'exploded' ? 'primary' : 'secondary'}`}
                        style={{marginTop: 0, padding: '0.5rem', flex: '1 1 40%'}}
                        onClick={() => setViewMode('exploded')}
                      >
                        Exploded
                      </button>
                      <button 
                        className={`action-button ${viewMode === 'mold' ? 'primary' : 'secondary'}`}
                        style={{marginTop: 0, padding: '0.5rem', flex: '1 1 40%'}}
                        onClick={() => setViewMode('mold')}
                      >
                        Mold Blocks
                      </button>
                      {moldParts.cooling_url && (
                         <button 
                           className={`action-button ${viewMode === 'cooling' ? 'primary' : 'secondary'}`}
                           style={{marginTop: 0, padding: '0.5rem', flex: '1 1 40%', borderColor: '#60a5fa', color: viewMode === 'cooling' ? 'white' : '#60a5fa'}}
                           onClick={() => setViewMode('cooling')}
                         >
                           + Cooling Channels
                         </button>
                      )}
                      {moldParts.undercut_url && (
                        <button 
                          className={`action-button ${viewMode === 'undercuts' ? 'primary' : 'secondary'}`}
                          style={{marginTop: 0, padding: '0.5rem', flex: '1 1 40%', borderColor: '#ef4444', color: viewMode === 'undercuts' ? 'white' : '#ef4444'}}
                          onClick={() => setViewMode('undercuts')}
                        >
                          Show Undercuts
                        </button>
                      )}
                   </div>
                   
                   <div style={{ marginTop: '1.5rem', background: 'rgba(255,255,255,0.03)', padding: '1rem', borderRadius: '8px' }}>
                      <h4 style={{ fontSize: '0.85rem', color: '#cbd5e1', marginBottom: '0.8rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Viewing Options</h4>
                      
                      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
                        <label style={{ fontSize: '0.9rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                          <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />
                          Wireframe
                        </label>
                        <label style={{ fontSize: '0.9rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                          <input type="checkbox" checked={autoRotate} onChange={(e) => setAutoRotate(e.target.checked)} />
                          Auto-Rotate
                        </label>
                      </div>

                      {viewMode === 'exploded' && (
                        <div className="slider-container">
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                            <label className="label" style={{ fontSize: '0.85rem' }}>Explode Distance</label>
                            <span className="value" style={{ fontSize: '0.85rem', fontFamily: 'monospace' }}>{(explodeDist * 100).toFixed(0)}%</span>
                          </div>
                          <input 
                            type="range" 
                            min="0" 
                            max="3" 
                            step="0.05" 
                            value={explodeDist}
                            onChange={(e) => setExplodeDist(parseFloat(e.target.value))}
                            style={{ width: '100%', cursor: 'pointer' }}
                          />
                        </div>
                      )}
                   </div>
                   
                   <button 
                    className="action-button secondary"
                    style={{ marginTop: '1.5rem' }}
                    onClick={handleSplit}
                    disabled={splitting}
                  >
                    <Settings size={18} />
                    {splitting ? "Re-generating..." : "Update Split Plane"}
                  </button>
                </div>
              )}
            </div>
          )}

          {results && (
            <div className="card ai-card fade-in" style={{ borderColor: 'rgba(167, 139, 250, 0.4)', background: 'linear-gradient(180deg, rgba(30, 41, 59, 0.8) 0%, rgba(15, 23, 42, 0.9) 100%)', marginTop: '1.5rem' }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#a78bfa' }}>
                <Sparkles size={18} /> AI Manufacturing Advisor
              </h2>
              
              {!aiAdvice && !aiLoading && (
                <div style={{ marginTop: '1rem', background: 'rgba(255,255,255,0.03)', padding: '1rem', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: '#94a3b8', marginBottom: '0.3rem' }}>Target Material</label>
                      <select 
                        value={material} 
                        onChange={(e) => setMaterial(e.target.value)}
                        style={{ width: '100%', padding: '0.5rem', background: '#1e293b', color: 'white', border: '1px solid #334155', borderRadius: '4px' }}
                      >
                        <option value="ABS">ABS</option>
                        <option value="Polycarbonate">Polycarbonate (PC)</option>
                        <option value="Nylon">Nylon (PA6)</option>
                        <option value="Polypropylene">Polypropylene (PP)</option>
                        <option value="Delrin">Delrin (POM)</option>
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: '#94a3b8', marginBottom: '0.3rem' }}>Annual Volume</label>
                      <select 
                        value={productionVolume} 
                        onChange={(e) => setProductionVolume(parseInt(e.target.value))}
                        style={{ width: '100%', padding: '0.5rem', background: '#1e293b', color: 'white', border: '1px solid #334155', borderRadius: '4px' }}
                      >
                        <option value={1000}>1,000 units</option>
                        <option value={10000}>10,000 units</option>
                        <option value={100000}>100,000 units</option>
                        <option value={500000}>500,000+ units</option>
                      </select>
                    </div>
                  </div>
                  <button 
                    className="action-button"
                    style={{ background: 'linear-gradient(135deg, #8b5cf6, #d946ef)', color: 'white', marginTop: 0 }}
                    onClick={handleAskAI}
                  >
                    <Sparkles size={18} />
                    Generate Cost & Manufacturing Report
                  </button>
                </div>
              )}
              
              {aiLoading && <p style={{ color: '#cbd5e1', fontSize: '0.9rem', marginTop: '1rem' }}>Analyzing geometry with NVIDIA AI...</p>}
              
              {aiAdvice && (
                <div className="ai-response" style={{ fontSize: '0.9rem', color: '#e2e8f0', lineHeight: '1.6', whiteSpace: 'pre-wrap', marginTop: '1rem', padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '0.5rem' }}>
                  {aiAdvice}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="viewer-container">
          {activeUrl ? (
            <Canvas camera={{ position: [0, 0, results ? Math.max(...results.extents)*1.5 : 150], fov: 50 }}>
              <ambientLight intensity={0.5} />
              <spotLight position={[10, 10, 10]} angle={0.15} penumbra={1} intensity={1} />
              <Environment preset="city" />
              
              <axesHelper args={[results ? Math.max(...results.extents) * 1.5 : 100]} />
              
              <Center>
                <group>
                  {/* Visualizing the split plane when adjusting the slider */}
                  {results && !moldParts && (
                    <mesh position={[0, 0, zSplit - ((results.bounding_box[0][2] + results.bounding_box[1][2])/2)]}>
                       <planeGeometry args={[results.extents[0]*2, results.extents[1]*2]} />
                       <meshBasicMaterial color="#60a5fa" transparent opacity={0.3} side={2} />
                    </mesh>
                  )}

                  {viewMode === 'part' && (
                    <Model 
                      url={activeUrl} 
                      color="#3b82f6" 
                      wireframe={wireframe} 
                      rotation={(!results && !autoOrient) ? [rotX * Math.PI/180, rotY * Math.PI/180, rotZ * Math.PI/180] : [0,0,0]} 
                    />
                  )}
                  
                  {moldParts && viewMode === 'exploded' && (
                    <>
                      <Model url={moldParts.core_url} color="#ef4444" position={[0, 0, -results.extents[2]*explodeDist]} wireframe={wireframe} />
                      <Model url={moldParts.cavity_url} color="#10b981" position={[0, 0, results.extents[2]*explodeDist]} wireframe={wireframe} />
                      <Model url={activeUrl} color="#3b82f6" transparent opacity={0.5} wireframe={wireframe} />
                    </>
                  )}

                  {moldParts && (viewMode === 'mold' || viewMode === 'cooling') && (
                    <>
                      <Model url={moldParts.core_url} color="#ef4444" transparent opacity={0.6} wireframe={wireframe} />
                      <Model url={moldParts.cavity_url} color="#10b981" transparent opacity={0.6} wireframe={wireframe} />
                      {viewMode === 'cooling' && moldParts.cooling_url && (
                         <Model url={moldParts.cooling_url} color="#3b82f6" transparent opacity={0.9} wireframe={wireframe} />
                      )}
                    </>
                  )}

                  {moldParts && viewMode === 'undercuts' && (
                    <>
                      <Model url={activeUrl} color="#334155" transparent opacity={0.7} wireframe={wireframe} />
                      <Model url={moldParts.undercut_url} color="#ef4444" wireframe={wireframe} />
                    </>
                  )}
                </group>
              </Center>

              <OrbitControls makeDefault autoRotate={autoRotate} autoRotateSpeed={2.5} />
            </Canvas>
          ) : (
            <div className="empty-viewer">
              <Box size={64} className="icon-empty" />
              <p>3D Preview will appear here</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
