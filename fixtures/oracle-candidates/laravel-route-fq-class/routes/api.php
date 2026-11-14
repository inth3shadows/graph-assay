<?php
use Illuminate\Support\Facades\Route;
Route::get('/admin/users/{id}', [\App\Http\Controllers\Admin\UserController::class, 'show']);
