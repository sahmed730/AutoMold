from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
import trimesh
import tempfile
import os
import uuid
import numpy as np
import math

app = FastAPI(title="AutoMold API")

os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"status": "AutoMold Backend is running"}

@app.post("/api/analyze")
def analyze_stl(
    file: UploadFile = File(...), 
    auto_orient: bool = Form(False),
    rot_x: float = Form(0.0),
    rot_y: float = Form(0.0),
    rot_z: float = Form(0.0)
):
    if not file.filename.lower().endswith('.stl'):
        return {"error": "Only STL files are supported"}

    with tempfile.NamedTemporaryFile(delete=False, suffix=".stl") as tmp:
        content = file.file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        mesh = trimesh.load(tmp_path)
        
        if auto_orient:
            mesh.apply_transform(mesh.principal_inertia_transform)
            # Smart Orient: Align the shortest bounding box axis to the Z-axis (pull direction)
            # This minimizes mold depth and machining cost.
            shortest_axis = np.argmin(mesh.extents)
            if shortest_axis == 0:
                mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2, [0,1,0]))
            elif shortest_axis == 1:
                mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2, [1,0,0]))
        else:
            rot_matrix = trimesh.transformations.euler_matrix(math.radians(rot_x), math.radians(rot_y), math.radians(rot_z))
            mesh.apply_transform(rot_matrix)
            
        mesh.apply_translation(-mesh.bounds.mean(axis=0))

        is_watertight = mesh.is_watertight
        try:
            volume = float(mesh.volume) if is_watertight else None
        except:
            volume = None
            
        # Draft angle defect analysis: Find vertical faces (normals perpendicular to Z axis)
        normals = mesh.face_normals
        vertical_faces = np.sum(np.abs(normals[:, 2]) < 0.03) # Less than ~1.7 degrees draft
        draft_warning_pct = (vertical_faces / len(mesh.faces)) * 100 if len(mesh.faces) > 0 else 0

        bounding_box = mesh.bounds.tolist()
        extents = mesh.extents.tolist()
        faces = len(mesh.faces)
        vertices = len(mesh.vertices)

        run_id = str(uuid.uuid4())[:8]
        processed_filename = f"processed_{run_id}.stl"
        mesh.export(f"static/{processed_filename}")

        return {
            "filename": file.filename,
            "is_watertight": bool(is_watertight),
            "volume": volume,
            "bounding_box": bounding_box,
            "extents": extents,
            "faces": faces,
            "vertices": vertices,
            "draft_warning_pct": draft_warning_pct,
            "processed_url": f"http://127.0.0.1:8000/static/{processed_filename}"
        }
    except Exception as e:
        return {"error": str(e)}
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

@app.post("/api/split")
def split_mold(
    file: UploadFile = File(...), 
    z_split: float = Form(0.0), 
    auto_orient: bool = Form(False),
    rot_x: float = Form(0.0),
    rot_y: float = Form(0.0),
    rot_z: float = Form(0.0)
):
    if not file.filename.lower().endswith('.stl'):
        return {"error": "Only STL files are supported"}

    with tempfile.NamedTemporaryFile(delete=False, suffix=".stl") as tmp:
        content = file.file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        part = trimesh.load(tmp_path)
        
        if not part.is_watertight:
            trimesh.repair.fill_holes(part)
            trimesh.repair.fix_normals(part)
            
        if not part.is_watertight:
            # Fallback: Robust Voxel Reconstruction
            # This converts broken surface meshes into solid 3D grids, then back to a watertight mesh
            try:
                print("Mesh is broken. Attempting robust voxel reconstruction...")
                pitch = part.extents.max() / 200.0
                voxels = part.voxelized(pitch=pitch).fill()
                part = voxels.marching_cubes
                print("Voxel reconstruction successful!")
            except Exception as e:
                return {"error": f"Mesh is an open surface and automated voxel reconstruction failed: {str(e)}. Please close the holes in your CAD software."}
            
            if not part.is_watertight:
                 return {"error": "Automated mesh repair failed. Mold generation requires a solid (watertight) part to perform boolean cuts. Please fix your CAD file."}

        if auto_orient:
            part.apply_transform(part.principal_inertia_transform)
            shortest_axis = np.argmin(part.extents)
            if shortest_axis == 0:
                part.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2, [0,1,0]))
            elif shortest_axis == 1:
                part.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2, [1,0,0]))
        else:
            rot_matrix = trimesh.transformations.euler_matrix(math.radians(rot_x), math.radians(rot_y), math.radians(rot_z))
            part.apply_transform(rot_matrix)
            
        part.apply_translation(-part.bounds.mean(axis=0))

        bounds = part.bounds
        extents = part.extents
        center = bounds.mean(axis=0)

        face_centers = part.triangles.mean(axis=1)
        normals = part.face_normals
        
        top_undercuts = np.where((normals[:, 2] < -0.01) & (face_centers[:, 2] > z_split))[0]
        bottom_undercuts = np.where((normals[:, 2] > 0.01) & (face_centers[:, 2] < z_split))[0]
        all_undercuts = np.concatenate((top_undercuts, bottom_undercuts))
        
        if len(all_undercuts) > 0:
            undercut_mesh = part.submesh([all_undercuts], append=True)
        else:
            undercut_mesh = trimesh.Trimesh()

        margin = max(extents) * 0.2
        block_extents = extents + (margin * 2)

        min_z = center[2] - block_extents[2]/2
        max_z = center[2] + block_extents[2]/2
        z_split = max(min_z + margin, min(z_split, max_z - margin))

        core_height = z_split - min_z
        core_extents = block_extents.copy()
        core_extents[2] = core_height
        core_center = center.copy()
        core_center[2] = min_z + core_height / 2
        core_block = trimesh.creation.box(extents=core_extents, transform=trimesh.transformations.translation_matrix(core_center))

        cavity_height = max_z - z_split
        cavity_extents = block_extents.copy()
        cavity_extents[2] = cavity_height
        cavity_center = center.copy()
        cavity_center[2] = z_split + cavity_height / 2
        cavity_block = trimesh.creation.box(extents=cavity_extents, transform=trimesh.transformations.translation_matrix(cavity_center))

        pin_radius = margin * 0.2
        pin_height = margin * 0.6
        pin_offsets = [
            (block_extents[0]/2 - margin*0.6, block_extents[1]/2 - margin*0.6),
            (-block_extents[0]/2 + margin*0.6, block_extents[1]/2 - margin*0.6),
            (block_extents[0]/2 - margin*0.6, -block_extents[1]/2 + margin*0.6),
            (-block_extents[0]/2 + margin*0.6, -block_extents[1]/2 + margin*0.6),
        ]

        pins = []
        for ox, oy in pin_offsets:
            pin = trimesh.creation.cylinder(radius=pin_radius, height=pin_height)
            pin.apply_translation([center[0] + ox, center[1] + oy, z_split])
            pins.append(pin)

        if pins:
            pins_mesh = trimesh.util.concatenate(pins)
            try:
                core_block = core_block.union(pins_mesh, engine='manifold')
                holes = []
                for ox, oy in pin_offsets:
                    hole = trimesh.creation.cylinder(radius=pin_radius * 1.1, height=pin_height * 1.2)
                    hole.apply_translation([center[0] + ox, center[1] + oy, z_split])
                    holes.append(hole)
                holes_mesh = trimesh.util.concatenate(holes)
                cavity_block = cavity_block.difference(holes_mesh, engine='manifold')
            except Exception as e:
                print("Failed boolean pins:", e)

        # 5. Injection Feed System (Phase 3: Sprue & Runner)
        try:
            sprue_radius = margin * 0.15
            sprue_height = cavity_height + margin * 0.5
            sprue = trimesh.creation.cylinder(radius=sprue_radius, height=sprue_height)
            sprue_x = center[0] + extents[0]/2 + margin*0.8
            sprue.apply_translation([sprue_x, center[1], z_split + cavity_height/2])

            runner_len = sprue_x - center[0]
            runner = trimesh.creation.cylinder(radius=sprue_radius*0.8, height=runner_len)
            runner.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2, [0,1,0]))
            runner.apply_translation([center[0] + runner_len/2, center[1], z_split])
            
            feed_system = trimesh.util.concatenate([sprue, runner])
            
            cavity_block = cavity_block.difference(feed_system, engine='manifold')
            core_block = core_block.difference(runner, engine='manifold')
        except Exception as e:
            print("Failed boolean feed system:", e)

        # 6. Automated Cooling Channel Generation (Phase 3)
        try:
            cooling_radius = margin * 0.12
            cooling_pitch = extents[0] / 4.0  # Spacing between channels
            num_channels = int(extents[1] / cooling_pitch) + 1
            
            cooling_lines = []
            start_y = center[1] - (num_channels-1)*cooling_pitch/2
            
            # Create parallel cooling lines in X direction
            for i in range(num_channels):
                y_pos = start_y + i * cooling_pitch
                # Cavity cooling line (Top)
                c_top = trimesh.creation.cylinder(radius=cooling_radius, height=block_extents[0]*1.2)
                c_top.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2, [0,1,0]))
                c_top.apply_translation([center[0], y_pos, z_split + cavity_height*0.5])
                cooling_lines.append(c_top)
                
                # Core cooling line (Bottom)
                c_bot = trimesh.creation.cylinder(radius=cooling_radius, height=block_extents[0]*1.2)
                c_bot.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2, [0,1,0]))
                c_bot.apply_translation([center[0], y_pos, z_split - core_height*0.5])
                cooling_lines.append(c_bot)
                
            cooling_mesh = trimesh.util.concatenate(cooling_lines)
            
            # Boolean subtract from mold blocks
            cavity_block = cavity_block.difference(cooling_mesh, engine='manifold')
            core_block = core_block.difference(cooling_mesh, engine='manifold')
        except Exception as e:
            print("Failed boolean cooling system:", e)
            cooling_mesh = trimesh.Trimesh()

        try:
            core_mold = core_block.difference(part, engine='manifold')
            cavity_mold = cavity_block.difference(part, engine='manifold')
        except Exception as e:
            core_mold = core_block.difference(part)
            cavity_mold = cavity_block.difference(part)

        run_id = str(uuid.uuid4())[:8]
        core_filename = f"core_{run_id}.stl"
        cavity_filename = f"cavity_{run_id}.stl"
        undercut_filename = f"undercuts_{run_id}.stl"
        cooling_filename = f"cooling_{run_id}.stl"
        
        core_mold.export(f"static/{core_filename}")
        cavity_mold.export(f"static/{cavity_filename}")
        
        if len(undercut_mesh.faces) > 0:
            undercut_mesh.export(f"static/{undercut_filename}")
            
        if len(cooling_mesh.faces) > 0:
            cooling_mesh.export(f"static/{cooling_filename}")

        return {
            "core_url": f"http://127.0.0.1:8000/static/{core_filename}",
            "cavity_url": f"http://127.0.0.1:8000/static/{cavity_filename}",
            "cooling_url": f"http://127.0.0.1:8000/static/{cooling_filename}" if len(cooling_mesh.faces) > 0 else None,
            "undercut_url": f"http://127.0.0.1:8000/static/{undercut_filename}" if len(undercut_mesh.faces) > 0 else None,
            "undercut_count": len(all_undercuts)
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": str(e)}
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.post("/api/ai-advisor")
def ai_advisor(
    volume: float = Form(0.0),
    extents_x: float = Form(0.0),
    extents_y: float = Form(0.0),
    extents_z: float = Form(0.0),
    undercut_count: int = Form(0),
    faces: int = Form(0),
    draft_warning_pct: float = Form(0.0),
    material: str = Form("ABS"),
    production_volume: int = Form(10000)
):
    try:
        client = OpenAI(
          base_url="https://integrate.api.nvidia.com/v1",
          api_key="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",
          timeout=10.0
        )
        
        prompt = f"""You are an expert Injection Molding DFM (Design for Manufacturing) and Mold Flow Analysis AI.
        Part Data:
        - Dimensions: {extents_x:.2f} x {extents_y:.2f} x {extents_z:.2f} mm
        - Volume: {volume:.2f} mm³
        - Total Faces: {faces}
        - Undercut Faces: {undercut_count}
        - Draft Angle Warning: {draft_warning_pct:.1f}% of faces have < 1.7° draft (vertical walls).
        - Selected Material: {material}
        - Annual Production Volume: {production_volume} units

        Provide a strict, professional DFM and Mold Flow report. Do not include unwanted conversational text. Use the following markdown sections:

        ### 1. DFM Guidelines Check
        Evaluate the part for standard DFM rules:
        - **Draft Angles:** Analyze the {draft_warning_pct:.1f}% draft warning.
        - **Corner Radii (Rounds):** Explain why sharp corners must be filleted for {material} to reduce stress concentrations.
        - **Uniform Thickness:** Discuss how non-uniform thickness in a {max(extents_x, extents_y):.0f}mm part leads to warpage and sink marks.

        ### 2. AI Mold Flow Analysis
        Act as a Mold Flow simulator. Based on the dimensions and {material} properties:
        - Recommend the optimal gate type and location to ensure balanced filling.
        - Predict potential weld lines or air traps.
        - Estimate injection pressure and cooling cycle time.

        ### 3. Tooling Cost & Optimization
        Estimate steel mold cost ($ USD) and per-part cost. Discuss if sliders/lifters are needed for the {undercut_count} undercuts.
        """

        def generate():
            try:
                completion = client.chat.completions.create(
                  model="meta/llama-3.1-70b-instruct",
                  messages=[{"role":"user","content": prompt}],
                  temperature=0.7,
                  top_p=1,
                  max_tokens=800,
                  stream=True
                )
                for chunk in completion:
                    if chunk.choices and chunk.choices[0].delta.content:
                        yield chunk.choices[0].delta.content
            except Exception as e:
                yield f'{{"error": "{str(e)}"}}'

        return StreamingResponse(generate(), media_type="text/plain")
    except Exception as e:
        return {"error": str(e)}
