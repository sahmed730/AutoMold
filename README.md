# AutoMold AI v2 🏭

AutoMold is an intelligent, fully automated web application designed to accelerate the injection molding engineering pipeline. By simply uploading a 3D CAD model (STL), the system automatically analyzes the geometry, detects undercuts, generates precise tooling (Core & Cavity blocks), calculates cooling channels, and provides an expert-level manufacturing cost report powered by NVIDIA GLM-5.2 AI.

## ✨ Key Features

- **Automated Tooling Generation:** Upload an STL and automatically slice it into Core and Cavity mold halves.
- **Smart Auto-Orient:** Automatically aligns the shortest axis of the part to the pull direction to minimize mold depth and machining costs.
- **Robust Voxel Reconstruction:** Automatically repairs broken, open-surface CAD files by dynamically converting them into solid voxel grids and re-meshing them via marching cubes.
- **Cooling Channel Engineering:** Procedurally drills parallel cooling water lines precisely offset from the parting line.
- **Defect Analysis (Draft Angles & Undercuts):** Mathematically flags faces with less than 1.7° draft and isolates undercut regions that require side-action sliders.
- **AI Manufacturing Advisor (GLM-5.2):** Select a target material (ABS, Polycarbonate, Nylon, etc.) and annual volume to instantly generate a professional engineering report covering tooling costs, cycle times, and shrinkage compensation.

## 🛠️ Technology Stack

- **Frontend:** React (Vite), Three.js (React Three Fiber for 3D rendering), Tailwind/CSS Glassmorphism
- **Backend:** Python, FastAPI, Uvicorn
- **Math Engine:** Trimesh, Shapely, Scikit-Image, NetworkX
- **AI Engine:** NVIDIA GLM-5.2 via OpenAI Python Client

## 🚀 Getting Started

### 1. Backend Setup

Ensure you have Python installed, then navigate to the backend directory:

```bash
cd backend
python -m venv venv
.\venv\Scripts\activate   # On Windows
pip install -r requirements.txt
pip install scikit-image scipy networkx rtree shapely
```

Start the API server:
```bash
uvicorn main:app --reload
```
*The backend will run on `http://127.0.0.1:8000`*

### 2. Frontend Setup

In a new terminal, navigate to the frontend directory:

```bash
cd frontend
npm install
npm run dev
```
*The web app will be available at `http://localhost:5173`*

## 📖 How to Use

1. **Upload Model:** Drag and drop any `.stl` file into the upload zone.
2. **Analyze Geometry:** Click "Analyze Geometry" to calculate bounding boxes, detect draft angle defects, and automatically orient the part for optimal molding.
3. **Design Parting Line:** Use the Z-Plane Height slider to adjust the parting line where the mold halves will separate.
4. **Generate Tooling:** Click "Generate Core, Cavity & Pins" to trigger the Boolean math engine. The UI will render the resulting mold blocks as well as the internal cooling channels.
5. **AI Report:** Scroll down to the AI section, select your target Material and Volume, and generate a complete cost and defect risk analysis.

## ⚠️ Notes on Geometry Processing
AutoMold relies heavily on boolean logic for mold subtraction. 
If your file is an open surface, the backend will automatically attempt to repair it using Voxel Reconstruction. If you still encounter generation errors, ensure your model is a single watertight solid in your CAD software before exporting!
